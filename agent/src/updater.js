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
const { createOrUpdateTask: defaultCreateOrUpdateTask, queryTaskXml: defaultQueryTaskXml, TASK_NAME } = require("./notices/task");

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
  const appDir = path.dirname(installExe);
  const files = [{ src: agentSrc, dst: installExe }];
  if (fs.existsSync(notifierSrc)) {
    files.push({ src: notifierSrc, dst: path.join(appDir, "MonitorTI-Notifier.exe") });
  }
  return { installExe, serviceName, sourceExe: agentSrc, files };
}

function run(argv, deps = {}) {
  const isPackage = argv.indexOf("--apply-update-package") >= 0;
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const createOrUpdateTask = deps.createOrUpdateTask || defaultCreateOrUpdateTask;
  const queryTaskXml = deps.queryTaskXml || defaultQueryTaskXml;
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
  const testMode = process.env.MTI_UPDATER_TEST === "1";

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

  function captureTaskSnapshot() {
    try {
      const out = queryTaskXml();
      taskSnapshot = out;
      taskAlreadyExisted = !!out;
      return out;
    } catch {
      taskSnapshot = null;
      taskAlreadyExisted = false;
      return null;
    }
  }

  function ensureNotifierTask() {
    try {
      createOrUpdateTask();
      taskTouched = true;
      log("task companion garantida: " + TASK_NAME);
      return true;
    } catch (e) {
      log("falha ao garantir task companion: " + e.message);
      return false;
    }
  }

  function rollbackTask() {
    if (!taskTouched) return;
    try {
      if (taskAlreadyExisted) {
        if (taskSnapshot) {
          const tmpXml = path.join(path.dirname(sourceExe || installExe), "notifier-companion-task.rollback.xml");
          try {
            fs.writeFileSync(tmpXml, taskSnapshot, "utf8");
            execFileSync("schtasks", ["/create", "/xml", tmpXml, "/tn", TASK_NAME, "/f"], { stdio: "ignore", timeout: 10000 });
            log("rollback da task companion: definicao previa restaurada");
          } finally {
            try { if (fs.existsSync(tmpXml)) fs.unlinkSync(tmpXml); } catch {}
          }
        } else {
          log("rollback da task companion: preservando definicao previa");
        }
      } else {
        log("rollback da task companion: removendo task criada");
        try { execFileSync("schtasks", ["/delete", "/tn", TASK_NAME, "/f"], { stdio: "ignore" }); } catch (e) {}
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
        if (fs.existsSync(b.previous)) {
          fs.copyFileSync(b.previous, b.dst);
          log("restaurado: " + b.previous);
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
      }
    }

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

    // 4.5) garante a task companion antes de reiniciar o Agent.
    captureTaskSnapshot();
    if (!ensureNotifierTask()) {
      throw new Error("nao foi possivel garantir a task companion");
    }

    // 5) reinicia o serviço
    if (!testMode) {
      execFileSync("net", ["start", serviceName], { stdio: "ignore" });
    } else {
      log("TEST: pulando inicio de servico");
    }

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

    // 7) se houver sessão interativa, solicita o run da task.
    if (!testMode || deps.allowTaskRunInTestMode) {
      if (hasInteractiveSession()) {
        try {
          execFileSync("schtasks", ["/run", "/tn", TASK_NAME], { stdio: "ignore", timeout: 10000 });
          log("task companion acionada apos update");
        } catch (e) {
          log("task companion nao foi acionada apos update: " + e.message);
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
  run(process.argv);
}
