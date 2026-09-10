// Atualizador independente do Monitor TI Agent.
// Executado a partir do NOVO executável (baixado), em um processo separado,
// para substituir com segurança o executável em uso e reiniciar o serviço.
// Toda a detecção de estado de serviço é independente de idioma/localidade:
//  - parada confirmada por bloqueio de arquivo (isFileUnlocked)
//  - PID/estado obtidos via CIM Win32_Service (propriedades estruturadas)
//
// Dois modos:
//  - --apply-update <installExe> <serviceName>
//      Atualização legada de arquivo único (v1.0.x). source = process.execPath.
//  - --apply-update-package <packageDir> <installExe> <serviceName>
//      Atualização em pacote (v1.1.0+): <packageDir> contém MonitorTI-Agent.exe
//      e MonitorTI-Notifier.exe. Ambos são trocados com backup/rollback individuais.
const fs = require("fs");
const path = require("path");
const { execFileSync: defaultExecFileSync } = require("child_process");
const WebSocket = require("ws");
const {
  createOrUpdateTask: defaultCreateOrUpdateTask,
  queryTaskState: defaultQueryTaskState,
  queryTaskXml: defaultQueryTaskXml,
  restoreTaskXml: defaultRestoreTaskXml,
  removeTask: defaultRemoveTask,
  runTask: defaultRunTask,
  disableTask: defaultDisableTask,
  enableTask: defaultEnableTask,
  TASK_NAME
} = require("./notices/task");

function log(m) {
  const line = `[updater ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try {
    const logPath = path.join(
      process.env.ProgramData || "C:\\ProgramData",
      "MonitorTI",
      "logs",
      "updater.log"
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + "\n");
  } catch (e) {
    /* log não deve interromper */
  }
}

function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

function formatTaskCommandFailure(operation, err) {
  const exitCode = err && typeof err.status === "number" ? err.status : (err && typeof err.code === "number" ? err.code : null);
  const stdout = err && err.stdout != null ? String(err.stdout) : "";
  const stderr = err && err.stderr != null ? String(err.stderr) : "";
  return (
    "operacao=" + operation +
    " exitCode=" + (exitCode === null ? "null" : exitCode) +
    " stdout=" + JSON.stringify(stdout.trim()) +
    " stderr=" + JSON.stringify(stderr.trim()) +
    " erro=" + (err && err.message ? err.message : String(err))
  );
}

function sanitizeUpdateMessage(message) {
  return String(message || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseOptionalArgs(argv) {
  function readFlag(name) {
    const idx = argv.indexOf(name);
    if (idx < 0 || idx + 1 >= argv.length) return null;
    return argv[idx + 1];
  }
  return {
    currentVersion: readFlag("--current-version"),
    targetVersion: readFlag("--target-version"),
    serverUrl: readFlag("--server-url"),
    deviceId: readFlag("--device-id")
  };
}

async function sendUpdateFailedToServer(ctx, details) {
  if (!ctx || !ctx.serverUrl || !ctx.deviceId) return false;
  const payload = {
    type: "update_status",
    deviceId: ctx.deviceId,
    status: "update_failed",
    currentVersion: ctx.currentVersion || null,
    targetVersion: ctx.targetVersion || null,
    version: ctx.targetVersion || null,
    stage: details.stage || null,
    error: sanitizeUpdateMessage(details.error),
    rolledBack: !!details.rolledBack,
    timestamp: new Date().toISOString()
  };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      resolve(ok);
    };
    const ws = new WebSocket(ctx.serverUrl);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch (e) {}
      finish(false);
    }, 5000);
    if (typeof timer.unref === "function") timer.unref();
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({
          type: "register",
          data: { deviceId: ctx.deviceId, agentVersion: ctx.currentVersion, updateStatusOnly: true }
        }));
      } catch (e) {
        clearTimeout(timer);
        finish(false);
      }
    });
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type !== "register_ack" || message.deviceId !== ctx.deviceId) return;
        ws.send(JSON.stringify(payload), (err) => {
          clearTimeout(timer);
          if (err) return finish(false);
          setTimeout(() => finish(true), 100);
        });
      } catch (e) {
        clearTimeout(timer);
        finish(false);
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      finish(false);
    });
  });
}

// Retorna true se o arquivo NÃO está travado (pode ser aberto para escrita).
// Em Windows, um executável em execução não pode ser aberto em modo leitura+escrita.
function isFileUnlocked(p) {
  try {
    const fd = fs.openSync(p, "r+");
    fs.closeSync(fd);
    return true;
  } catch (e) {
    return false;
  }
}

// Consulta estruturada do serviço via CIM Win32_Service (Win32_Service.State
// é sempre "Running"/"Stopped" em inglês, independente do idioma do Windows).
function getServiceInfo(svc) {
  try {
    const ps =
      "Get-CimInstance -ClassName Win32_Service -Filter \"Name='" + svc + "'\"" +
      " | Select-Object -Property State,ProcessId | ConvertTo-Json -Compress";
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
    );
    const obj = JSON.parse(out.trim());
    return { state: obj.State, processId: obj.ProcessId };
  } catch (e) {
    return null;
  }
}

function getNotifierProcesses(execFileSync = defaultExecFileSync) {
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='MonitorTI-Notifier.exe'\" | Select-Object ProcessId,Name | ConvertTo-Json -Compress";
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }
    );
    if (!String(out || "").trim()) return [];
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row) => row && row.Name === "MonitorTI-Notifier.exe" && Number(row.ProcessId) > 0)
      .map((row) => Number(row.ProcessId));
  } catch (e) {
    throw new Error("falha ao consultar processo MonitorTI-Notifier.exe: " + e.message);
  }
}

function terminateNotifierProcessByPid(pid, execFileSync = defaultExecFileSync) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) {
    throw new Error("PID invalido para MonitorTI-Notifier.exe");
  }
  execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", timeout: 15000 });
}

function waitForNotifierExit(queryProcesses, sleepImpl = sleep, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (queryProcesses().length === 0) return true;
    sleepImpl(250);
  }
  return queryProcesses().length === 0;
}

// Parsing robusto baseado na flag --apply-update (arquivo único, legado).
function parseApplyUpdateArgs(argv) {
  const flagIndex = argv.indexOf("--apply-update");
  if (flagIndex < 0) {
    throw new Error("flag --apply-update ausente");
  }
  const installExe = argv[flagIndex + 1];
  const serviceName = argv[flagIndex + 2];
  if (installExe === undefined || serviceName === undefined) {
    throw new Error("argumentos posicionais apos --apply-update incompletos");
  }
  if (installExe === "--apply-update" || serviceName === "--apply-update") {
    throw new Error("flag --apply-update encontrada no lugar de caminho/servico");
  }
  const sourceExe = process.execPath;
  return {
    installExe,
    serviceName,
    sourceExe,
    files: [{ src: sourceExe, dst: installExe }],
  };
}

// Parsing do modo pacote (v1.1.0+).
function parseApplyUpdatePackageArgs(argv) {
  const flagIndex = argv.indexOf("--apply-update-package");
  if (flagIndex < 0) {
    throw new Error("flag --apply-update-package ausente");
  }
  const packageDir = argv[flagIndex + 1];
  const installExe = argv[flagIndex + 2];
  const serviceName = argv[flagIndex + 3];
  if (
    !packageDir ||
    !installExe ||
    !serviceName ||
    installExe === "--apply-update-package" ||
    serviceName === "--apply-update-package"
  ) {
    throw new Error("argumentos posicionais apos --apply-update-package incompletos");
  }
  const agentSrc = path.join(packageDir, "MonitorTI-Agent.exe");
  const notifierSrc = path.join(packageDir, "MonitorTI-Notifier.exe");
  const integritySrc = path.join(packageDir, "notifier-integrity.json");
  const appDir = path.dirname(installExe);
  const files = [{ src: agentSrc, dst: installExe }];
  if (fs.existsSync(notifierSrc)) {
    files.push({ src: notifierSrc, dst: path.join(appDir, "MonitorTI-Notifier.exe") });
  }
  if (fs.existsSync(integritySrc)) {
    files.push({ src: integritySrc, dst: path.join(appDir, "notifier-integrity.json") });
  }
  return { installExe, serviceName, sourceExe: agentSrc, files };
}

async function run(argv, deps = {}) {
  const testMode = process.env.MTI_UPDATER_TEST === "1";
  const isPackage = argv.indexOf("--apply-update-package") >= 0;
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const createOrUpdateTask = deps.createOrUpdateTask || (testMode ? (() => "test") : defaultCreateOrUpdateTask);
  const queryTaskState = deps.queryTaskState || (testMode ? (() => null) : defaultQueryTaskState);
  const queryTaskXml = deps.queryTaskXml || (testMode ? (() => null) : defaultQueryTaskXml);
  const restoreTaskXml = deps.restoreTaskXml || (testMode ? (() => "") : defaultRestoreTaskXml);
  const removeTask = deps.removeTask || (testMode ? (() => {}) : defaultRemoveTask);
  const runTask = deps.runTask || (testMode ? (() => {}) : defaultRunTask);
  const disableTask = deps.disableTask || (testMode ? (() => {}) : defaultDisableTask);
  const enableTask = deps.enableTask || (testMode ? (() => {}) : defaultEnableTask);
  const queryNotifierProcesses = deps.queryNotifierProcesses || (testMode ? (() => []) : (() => getNotifierProcesses(execFileSync)));
  const terminateNotifierProcess = deps.terminateNotifierProcess || (testMode ? (() => {}) : ((pid) => terminateNotifierProcessByPid(pid, execFileSync)));
  const sleepImpl = deps.sleep || sleep;
  const waitNotifierExit = deps.waitForNotifierExit || ((query) => waitForNotifierExit(query, sleepImpl, 10000));
  const updateContext = Object.assign(parseOptionalArgs(argv), deps.updateContext || {});
  const hasInteractiveSession = deps.hasInteractiveSession || (() => {
    try {
      const ps = "(Get-CimInstance Win32_ComputerSystem).UserName";
      const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
      return !!String(out || "").trim();
    } catch {
      return false;
    }
  });
  let parsed;
  try {
    parsed = isPackage ? parseApplyUpdatePackageArgs(argv) : parseApplyUpdateArgs(argv);
  } catch (e) {
    log("ERRO ao interpretar argumentos: " + e.message);
    process.exit(1);
    return;
  }
  const { installExe, serviceName, sourceExe, files } = parsed;

  // Validações OBRIGATÓRIAS antes de parar o serviço ou tocar em qualquer arquivo.
  const problems = [];
  if (!installExe || !installExe.endsWith("MonitorTI-Agent.exe"))
    problems.push("installExe nao termina com MonitorTI-Agent.exe");
  if (serviceName !== "MonitorTIAgent")
    problems.push("serviceName invalido (esperado MonitorTIAgent)");
  if (sourceExe && installExe && sourceExe === installExe)
    problems.push("sourceExe igual a installExe (nao pode substituir a si mesmo)");
  for (const f of files || []) {
    if (!f.src || !fs.existsSync(f.src)) problems.push("origem ausente: " + (f.src || ""));
    if (!f.dst) problems.push("destino ausente");
  }
  if (problems.length > 0) {
    problems.forEach((p) => log("validacao falhou: " + p));
    log("ERRO: parametros invalidos; NENHUMA acao de parada/substituicao foi executada");
    process.exit(1);
    return;
  }

  log(
    "modo=" + (isPackage ? "pacote" : "arquivo-unico") +
      " installExe=" + installExe +
      " serviceName=" + serviceName +
      " arquivos=" + files.length
  );

  const backups = [];
  let taskTouched = false;
  let taskAlreadyExisted = false;
  let taskSnapshot = null;
  let taskState = null;
  let taskDisabledByUpdater = false;
  let taskStateRestored = false;
  let stage = "init";

  function captureTaskSnapshot() {
    try {
      taskState = queryTaskState();
      log("notifier task state captured exists=" + !!(taskState && taskState.exists === true) + " enabled=" + (taskState && taskState.exists === true ? taskState.enabled !== false : false));
      const out = queryTaskXml();
      taskSnapshot = out;
      taskAlreadyExisted = !!out;
      return out;
    } catch (e) {
      log("falha ao capturar snapshot da task: " + formatTaskCommandFailure("queryxml", e));
      taskSnapshot = null;
      taskAlreadyExisted = false;
      throw e;
    }
  }

  function restoreTaskState() {
    if (!taskDisabledByUpdater || taskStateRestored) return;
    enableTask();
    log("notifier task state restored (enabled)");
    taskStateRestored = true;
  }

  function prepareNotifier() {
    captureTaskSnapshot();
    if (taskState && taskState.exists === true && taskState.enabled !== false) {
      disableTask();
      taskDisabledByUpdater = true;
      log("notifier task temporarily disabled: " + TASK_NAME);
    }

    let pids = queryNotifierProcesses();
    if (pids.length === 0) {
      log("notifier exited gracefully");
      return;
    }
    log("waiting for notifier process exit");
    if (waitNotifierExit(queryNotifierProcesses)) {
      log("notifier exited gracefully");
      return;
    }

    log("notifier graceful shutdown timeout");
    pids = queryNotifierProcesses();
    for (const pid of pids) {
      log("forcing notifier process termination pid=" + pid);
      terminateNotifierProcess(pid);
    }
    if (!waitNotifierExit(queryNotifierProcesses)) {
      throw new Error("nao foi possivel encerrar MonitorTI-Notifier.exe");
    }
    log("notifier process terminated");
  }

  function ensureNotifierTask() {
    try {
      const result = createOrUpdateTask();
      taskTouched = true;
      log("task companion garantida: " + TASK_NAME + (result ? " (" + String(result).trim() + ")" : ""));
      return true;
    } catch (e) {
      log("falha ao garantir task companion: " + formatTaskCommandFailure("ensure", e));
      return false;
    }
  }

  function rollbackTask() {
    if (!taskTouched) return;
    try {
      if (taskAlreadyExisted) {
        if (taskSnapshot) {
          try {
            restoreTaskXml(taskSnapshot);
            log("rollback da task companion: definicao previa restaurada");
          } catch (e) {
            log("falha ao restaurar task companion: " + formatTaskCommandFailure("restore", e));
          }
        } else {
          log("rollback da task companion: preservando definicao previa");
        }
      } else {
        log("rollback da task companion: removendo task criada");
        try { removeTask(); } catch (e) { log("falha ao remover task criada: " + formatTaskCommandFailure("remove", e)); }
      }
    } catch (e) {
      log("falha no rollback da task companion: " + e.message);
    }
  }

  function rollback() {
    log("INICIANDO ROLLBACK");
    rollbackTask();
    if (!testMode) {
      try {
        const info = getServiceInfo(serviceName);
        if (info && info.processId) {
          try {
            execFileSync("taskkill", ["/PID", String(info.processId), "/F"], { stdio: "ignore" });
          } catch (e) {}
        }
      } catch (e) {}
    }
    for (const b of backups) {
      try {
        if (b.previous && fs.existsSync(b.previous)) {
          fs.copyFileSync(b.previous, b.dst);
          log("restaurado: " + b.previous);
        } else if (!b.previous && fs.existsSync(b.dst)) {
          fs.rmSync(b.dst, { force: true });
          log("removido arquivo criado durante atualizacao: " + b.dst);
        }
      } catch (e) {
        log("falha ao restaurar " + b.dst + ": " + e.message);
      }
    }
    if (!testMode) {
      try {
        execFileSync("net", ["start", serviceName], { stdio: "ignore" });
      } catch (e) {}
    }
  }

  try {
    if (isPackage) {
      stage = "prepare_notifier";
      prepareNotifier();
    }

    stage = "stop_service";
    // 1) garante que o serviço está parado (idempotente)
    if (!testMode) {
      try {
        execFileSync("net", ["stop", serviceName], { stdio: "ignore" });
      } catch (e) {
        log("aviso ao parar servico (pode ja estar parado): " + e.message);
      }
    } else {
      log("TEST: pulando parada de servico");
    }

    stage = "wait_unlock";
    // 2) aguarda o executável instalado ficar desbloqueado (serviço parado)
    let stopped = false;
    if (testMode) {
      stopped = true;
    } else {
      for (let i = 0; i < 30; i++) {
        if (isFileUnlocked(installExe)) { stopped = true; break; }
        sleep(1000);
      }
      if (!stopped) {
        const info = getServiceInfo(serviceName);
        const pid = info ? info.processId : null;
        if (pid) {
          try {
            execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
          } catch (e) {}
        }
        for (let i = 0; i < 15; i++) {
          if (isFileUnlocked(installExe)) { stopped = true; break; }
          sleep(1000);
        }
      }
    }
    if (!stopped) {
      throw new Error("nao foi possivel parar o servico do agente");
    }
    log("servico parado e executavel desbloqueado");

    stage = "backup";
    // 3) backup de cada destino já existente
    for (const f of files) {
      if (fs.existsSync(f.dst)) {
        const prev = f.dst + ".previous";
        try {
          fs.copyFileSync(f.dst, prev);
          backups.push({ dst: f.dst, previous: prev });
          log("backup criado: " + prev);
        } catch (e) {
          throw new Error("falha ao criar backup de " + f.dst + ": " + e.message);
        }
      } else {
        backups.push({ dst: f.dst, previous: null });
      }
    }

    stage = "copy_files";
    // 4) substitui cada arquivo do pacote (somente com o destino desbloqueado; retry)
    for (const f of files) {
      let ok = false;
      for (let i = 0; i < 15 && !ok; i++) {
        if (fs.existsSync(f.dst) && !isFileUnlocked(f.dst)) {
          log("destino ainda travado; aguardando (tentativa " + i + ")");
          sleep(1000);
          continue;
        }
        try {
          fs.copyFileSync(f.src, f.dst);
          ok = true;
        } catch (e) {
          log("falha ao copiar " + f.dst + " (tentativa " + i + "): " + e.message);
          sleep(1000);
        }
      }
      if (!ok) {
        throw new Error("nao foi possivel substituir " + f.dst);
      }
    }
    log("arquivos substituidos");

    stage = "ensure_task";
    // Uma task existente teve seu estado preservado; somente crie uma ausente.
    if (isPackage && (!taskState || taskState.exists !== true)) {
      if (!ensureNotifierTask()) {
        throw new Error("nao foi possivel garantir a task companion");
      }
    }

    stage = "restart_service";
    // 5) reinicia o serviço
    if (!testMode) {
      execFileSync("net", ["start", serviceName], { stdio: "ignore" });
    } else {
      log("TEST: pulando inicio de servico");
    }

    stage = "verify_running";
    // 6) confirma início por consulta estruturada CIM (estado Running)
    let running = false;
    if (testMode) {
      running = true;
    } else {
      for (let i = 0; i < 20; i++) {
        const info = getServiceInfo(serviceName);
        if (info && info.state === "Running") { running = true; break; }
        sleep(1000);
      }
    }
    if (!running) {
      throw new Error("servico nao iniciou apos atualizacao");
    }

    if (isPackage) {
      stage = "restore_task_state";
      restoreTaskState();
    }

    stage = "activate_companion";
    // 7) se houver sessão interativa, solicita o run da task.
    if (isPackage && (!testMode || deps.allowTaskRunInTestMode)) {
      const shouldRunTask = taskState ? taskState.enabled !== false : taskTouched;
      if (shouldRunTask && hasInteractiveSession()) {
        try {
          runTask();
          log("task companion acionada apos update");
        } catch (e) {
          log("task companion nao foi acionada apos update: " + formatTaskCommandFailure("run", e));
          throw new Error("falha ao acionar task companion apos update");
        }
      } else {
        log("sem sessao interativa; task companion aguardara proximo logon");
      }
    }

    log("atualizacao concluida (servico Running)");
  } catch (e) {
    log("ERRO na atualizacao: " + e.message);
    if (backups.length) rollback();
    if (isPackage) {
      try {
        restoreTaskState();
      } catch (restoreErr) {
        log("falha ao restaurar estado da task companion: " + formatTaskCommandFailure("restore-state", restoreErr));
      }
    }
    try {
      await sendUpdateFailedToServer(updateContext, {
        stage,
        error: e.message,
        rolledBack: backups.length > 0
      });
    } catch (notifyErr) {
      log("falha ao notificar update_failed: " + notifyErr.message);
    }
    process.exit(1);
    return;
  }

  // limpeza do temporário (o updater roda a partir dele)
  try {
    if (sourceExe && fs.existsSync(sourceExe)) fs.unlinkSync(sourceExe);
  } catch (e) {}
  process.exit(0);
}

module.exports = {
  run,
  parseApplyUpdateArgs,
  parseApplyUpdatePackageArgs,
  isFileUnlocked,
  getServiceInfo,
};

if (require.main === module) {
  run(process.argv).catch((err) => {
    log("ERRO fatal no updater: " + err.message);
    process.exit(1);
  });
}
