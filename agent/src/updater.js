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
const crypto = require("crypto");
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

// Windows SCM can report a transient empty/StartPending state immediately
// after net start. The 30s window matches the normal SCM startup budget.
const SERVICE_START_TIMEOUT_MS = 30000;
const SERVICE_START_POLL_INTERVAL_MS = 250;
const SERVICE_STOP_TIMEOUT_MS = 30000;
const MANIFEST_NAME = "package-manifest.json";
const AGENT_NAME = "MonitorTI-Agent.exe";
const NOTIFIER_NAME = "MonitorTI-Notifier.exe";
const INTEGRITY_NAME = "notifier-integrity.json";

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

function sanitizeDiagnostic(value) {
  return String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function commandError(command, err) {
  const exitCode = err && typeof err.status === "number" ? err.status : null;
  const stdout = sanitizeDiagnostic(err && err.stdout);
  const stderr = sanitizeDiagnostic(err && err.stderr);
  return `comando=${command} exitCode=${exitCode === null ? "null" : exitCode} stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)} erro=${JSON.stringify(sanitizeDiagnostic(err && err.message))}`;
}

function systemBinary(name) {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(root, "System32", name);
}

function parseScQueryEx(stdout) {
  const text = String(stdout || "");
  const stateMatch = text.match(/^\s*(?:STATE|ESTADO)\s*:\s*(\d+)\b/im);
  const pidMatch = text.match(/^\s*PID\s*:\s*(\d+)\b/im);
  if (!stateMatch) return null;
  const stateCode = Number(stateMatch[1]);
  return {
    stateCode,
    state: stateCode === 4 ? "Running" : stateCode === 2 ? "StartPending" : stateCode === 1 ? "Stopped" : "Unknown",
    processId: pidMatch ? Number(pidMatch[1]) : 0
  };
}

function parsePowerShellService(stdout) {
  const obj = JSON.parse(String(stdout || "").trim());
  if (!obj || typeof obj !== "object") throw new Error("resposta CIM vazia");
  const state = String(obj.State || "");
  const processId = Number(obj.ProcessId || 0);
  return { state, stateCode: state === "Running" ? 4 : state === "StartPending" ? 2 : state === "Stopped" ? 1 : 0, processId };
}

function queryServiceState(serviceName, execFileSync = defaultExecFileSync) {
  const scPath = systemBinary("sc.exe");
  try {
    const stdout = execFileSync(scPath, ["queryex", serviceName], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000
    });
    const parsed = parseScQueryEx(stdout);
    if (parsed) return parsed;
    throw new Error("sc.exe nao retornou STATE numerico");
  } catch (scError) {
    const psPath = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const ps = "Get-CimInstance -ClassName Win32_Service -Filter \"Name='" + serviceName + "'\" | Select-Object -Property State,ProcessId | ConvertTo-Json -Compress";
    try {
      const stdout = execFileSync(psPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000
      });
      return parsePowerShellService(stdout);
    } catch (psError) {
      const detail = `${commandError(scPath + " queryex " + serviceName, scError)}; fallback=${commandError(psPath, psError)}`;
      const error = new Error(detail);
      error.serviceDiagnostics = detail;
      throw error;
    }
  }
}

// Compatibilidade de nome para consumidores antigos; a implementação real é queryServiceState.
function getServiceInfo(svc) {
  return queryServiceState(svc);
}

function waitForServiceRunning(serviceName, {
  getInfo = getServiceInfo,
  sleepImpl = sleep,
  now = () => Date.now(),
  timeoutMs = SERVICE_START_TIMEOUT_MS,
  pollIntervalMs = SERVICE_START_POLL_INTERVAL_MS,
  onProbe = () => {}
} = {}) {
  const startedAt = now();
  let attempts = 0;
  let lastInfo = null;
  while (now() - startedAt <= timeoutMs) {
    attempts += 1;
    try {
      lastInfo = getInfo(serviceName);
    } catch (error) {
      lastInfo = { state: "Unavailable", stateCode: 0, processId: 0, error: sanitizeDiagnostic(error.serviceDiagnostics || error.message) };
    }
    onProbe({ attempts, info: lastInfo, elapsedMs: now() - startedAt });
    if (lastInfo && (lastInfo.state === "Running" || lastInfo.stateCode === 4)) {
      return { running: true, attempts, elapsedMs: now() - startedAt, info: lastInfo };
    }
    if (now() - startedAt >= timeoutMs) break;
    sleepImpl(Math.min(pollIntervalMs, timeoutMs - (now() - startedAt)));
  }
  return { running: false, attempts, elapsedMs: now() - startedAt, info: lastInfo };
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
  const manifestPath = path.join(packageDir, MANIFEST_NAME);
  if (!isSafeOwnedDirectory(packageDir)) throw new Error("diretorio de pacote invalido ou reparse point");
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    validatePackageManifest(manifest, packageDir);
  }
  const agentSrc = path.join(packageDir, AGENT_NAME);
  const notifierSrc = path.join(packageDir, NOTIFIER_NAME);
  const integritySrc = path.join(packageDir, INTEGRITY_NAME);
  const appDir = path.dirname(installExe);
  const files = [{ src: agentSrc, dst: installExe }];
  if (!manifest || manifest.packageMode === "full") {
    if (fs.existsSync(notifierSrc)) {
      files.push({ src: notifierSrc, dst: path.join(appDir, NOTIFIER_NAME) });
    }
    if (fs.existsSync(integritySrc)) {
      files.push({ src: integritySrc, dst: path.join(appDir, INTEGRITY_NAME) });
    }
  }
  return { installExe, serviceName, sourceExe: agentSrc, files, packageMode: manifest ? manifest.packageMode : "full", manifest };
}

function validatePackageManifest(manifest, packageDir) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("manifesto de pacote invalido: schemaVersion");
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version || ""))) throw new Error("manifesto de pacote invalido: version");
  if (manifest.packageMode !== "agent-only" && manifest.packageMode !== "full") throw new Error("manifesto de pacote invalido: packageMode");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error("manifesto de pacote invalido: files");
  const declared = new Set(manifest.files.map((f) => f && f.name));
  const allowed = manifest.packageMode === "agent-only"
    ? new Set([AGENT_NAME, MANIFEST_NAME])
    : new Set([AGENT_NAME, NOTIFIER_NAME, INTEGRITY_NAME, MANIFEST_NAME]);
  for (const entry of manifest.files) {
    if (!entry || !allowed.has(entry.name) || !Number.isInteger(entry.size) || entry.size <= 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ""))) {
      throw new Error("manifesto de pacote invalido: allowlist/hash/tamanho");
    }
    const filePath = path.join(packageDir, entry.name);
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("arquivo declarado invalido: " + entry.name);
    if (stat.size !== entry.size || sha256File(filePath) !== String(entry.sha256).toLowerCase()) throw new Error("hash/tamanho invalido: " + entry.name);
  }
  for (const actual of fs.readdirSync(packageDir)) {
    // Resíduos físicos de um diretório legado são ignorados; somente entradas
    // declaradas no manifesto podem entrar no plano de atualização.
    if (declared.has(actual) || actual === MANIFEST_NAME) {
      if (fs.lstatSync(path.join(packageDir, actual)).isSymbolicLink()) throw new Error("reparse point no pacote: " + actual);
    }
  }
  if (manifest.packageMode === "agent-only" && (manifest.files.length !== 1 || !declared.has(AGENT_NAME))) {
    throw new Error("manifesto agent-only deve declarar somente MonitorTI-Agent.exe");
  }
  if (manifest.packageMode === "agent-only" && (manifest.notifierAction !== "preserve" || manifest.configAction !== "preserve" || manifest.serviceAction !== "restart")) {
    throw new Error("manifesto agent-only invalido: actions");
  }
}

function isSafeOwnedDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  return fs.realpathSync(dir) === path.resolve(dir);
}

function writeRecoveryMarker(installExe, details) {
  const marker = installExe + ".recovery.json";
  try {
    fs.writeFileSync(marker, JSON.stringify({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      installExe,
      ...details
    }, null, 2) + "\n", "utf8");
    log("recovery marker criado: " + marker);
  } catch (e) {
    log("falha ao criar recovery marker: " + sanitizeDiagnostic(e.message));
  }
}

async function run(argv, deps = {}) {
  const isPackage = argv.indexOf("--apply-update-package") >= 0;
  const execFileSync = deps.execFileSync || defaultExecFileSync;
  const queryServiceStateImpl = deps.queryServiceState || queryServiceState;
  const isFileUnlockedImpl = deps.isFileUnlocked || isFileUnlocked;
  const createOrUpdateTask = deps.createOrUpdateTask || defaultCreateOrUpdateTask;
  const queryTaskState = deps.queryTaskState || (() => defaultQueryTaskState(execFileSync));
  const queryTaskXml = deps.queryTaskXml || (() => defaultQueryTaskXml(execFileSync));
  const restoreTaskXml = deps.restoreTaskXml || ((xml) => defaultRestoreTaskXml(xml, execFileSync));
  const removeTask = deps.removeTask || (() => defaultRemoveTask(execFileSync));
  const runTask = deps.runTask || (() => defaultRunTask(execFileSync));
  const disableTask = deps.disableTask || (() => defaultDisableTask(execFileSync));
  const enableTask = deps.enableTask || (() => defaultEnableTask(execFileSync));
  const queryNotifierProcesses = deps.queryNotifierProcesses || (() => getNotifierProcesses(execFileSync));
  const terminateNotifierProcess = deps.terminateNotifierProcess || ((pid) => terminateNotifierProcessByPid(pid, execFileSync));
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
  const agentOnly = isPackage && parsed.packageMode === "agent-only";

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
    if (!agentOnly) rollbackTask();
    let restoreFailure = null;
    try {
      execFileSync("net.exe", ["stop", serviceName], { stdio: "ignore", timeout: 15000 });
    } catch (e) {}
    let serviceStopped = false;
    try {
      const info = queryServiceStateImpl(serviceName, execFileSync);
      if (info && info.processId) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(info.processId), "/F"], { stdio: "ignore", timeout: 15000 });
        } catch (e) {}
      }
    } catch (e) {}
    for (let i = 0; i < SERVICE_STOP_TIMEOUT_MS / 250; i++) {
      try {
        const info = queryServiceStateImpl(serviceName, execFileSync);
        serviceStopped = !info || (info.stateCode !== 4 && !info.processId);
      } catch (e) {
        serviceStopped = false;
      }
      if (serviceStopped && isFileUnlockedImpl(installExe)) break;
      sleepImpl(250);
    }
    if (!serviceStopped) {
      restoreFailure = { file: installExe, error: "servico nao confirmado como Stopped/PID encerrado antes da restauracao" };
    }
    for (const b of backups) {
      try {
        if (restoreFailure && restoreFailure.file === installExe && restoreFailure.error.startsWith("servico nao confirmado")) {
          throw new Error(restoreFailure.error);
        }
        if (b.previous && fs.existsSync(b.previous)) {
          if (!isFileUnlockedImpl(b.dst)) throw new Error("EBUSY: destino ainda bloqueado");
          fs.copyFileSync(b.previous, b.dst);
          if (sha256File(b.previous) !== sha256File(b.dst)) throw new Error("hash divergente apos restauracao");
          log("restaurado: " + b.previous);
        } else if (!b.previous && fs.existsSync(b.dst)) {
          fs.rmSync(b.dst, { force: true });
          log("removido arquivo criado durante atualizacao: " + b.dst);
        }
      } catch (e) {
        restoreFailure = restoreFailure || { file: b.dst, error: sanitizeDiagnostic(e.message) };
        log("falha ao restaurar " + b.dst + ": " + e.message);
      }
    }
    if (restoreFailure) {
      writeRecoveryMarker(installExe, { rollbackCompleted: false, restoreFailure });
    }
    try {
      execFileSync("net.exe", ["start", serviceName], { stdio: "ignore" });
    } catch (e) {}
    return !restoreFailure;
  }

  try {
    if (isPackage && !agentOnly) {
      stage = "prepare_notifier";
      prepareNotifier();
    }

    stage = "stop_service";
    // 1) garante que o serviço está parado (idempotente)
    try {
      execFileSync("net.exe", ["stop", serviceName], { stdio: "ignore" });
    } catch (e) {
      log("aviso ao parar servico (pode ja estar parado): " + e.message);
    }

    stage = "wait_unlock";
    // 2) aguarda o executável instalado ficar desbloqueado (serviço parado)
    let stopped = false;
    for (let i = 0; i < 30; i++) {
      if (isFileUnlockedImpl(installExe)) { stopped = true; break; }
      sleepImpl(1000);
    }
    if (!stopped) {
      const info = queryServiceStateImpl(serviceName, execFileSync);
      const pid = info ? info.processId : null;
      if (pid) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
        } catch (e) {}
      }
      for (let i = 0; i < 15; i++) {
        if (isFileUnlockedImpl(installExe)) { stopped = true; break; }
        sleepImpl(1000);
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
        if (fs.existsSync(f.dst) && !isFileUnlockedImpl(f.dst)) {
          log("destino ainda travado; aguardando (tentativa " + i + ")");
          sleepImpl(1000);
          continue;
        }
        try {
          fs.copyFileSync(f.src, f.dst);
          ok = true;
        } catch (e) {
          log("falha ao copiar " + f.dst + " (tentativa " + i + "): " + e.message);
          sleepImpl(1000);
        }
      }
      if (!ok) {
        throw new Error("nao foi possivel substituir " + f.dst);
      }
    }
    log("arquivos substituidos");

    stage = "ensure_task";
    // Uma task existente teve seu estado preservado; somente crie uma ausente.
    if (isPackage && !agentOnly && (!taskState || taskState.exists !== true)) {
      if (!ensureNotifierTask()) {
        throw new Error("nao foi possivel garantir a task companion");
      }
    }

    stage = "restart_service";
    // 5) reinicia o serviço
    try {
      log("service_start_command issued service=" + serviceName);
      execFileSync("net.exe", ["start", serviceName], { stdio: "ignore" });
    } catch (error) {
      log("service_start_command returned error; continuing SCM polling: " + error.message);
    }

    stage = "verify_running";
    // 6) confirma início por polling CIM; null/StartPending são transitórios.
    const verification = waitForServiceRunning(serviceName, {
      getInfo: () => queryServiceStateImpl(serviceName, execFileSync),
      sleepImpl,
      onProbe: ({ attempts, info, elapsedMs }) => log(
        "service_start_probe attempt=" + attempts +
        " elapsedMs=" + elapsedMs +
        " state=" + (info && info.state ? info.state : "UNAVAILABLE")
      )
    });
    log(
      "service_start_result running=" + verification.running +
      " attempts=" + verification.attempts +
      " elapsedMs=" + verification.elapsedMs
    );
    if (!verification.running) {
      throw new Error("servico nao iniciou apos atualizacao");
    }

    if (isPackage && !agentOnly) {
      stage = "restore_task_state";
      restoreTaskState();
    }

    stage = "activate_companion";
    // 7) se houver sessão interativa, solicita o run da task.
    if (isPackage) {
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
    const rollbackOk = backups.length ? rollback() : true;
    if (!rollbackOk) log("ROLLBACK INCOMPLETO: recovery marker necessario");
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
  queryServiceState,
  getServiceInfo,
  waitForServiceRunning,
  SERVICE_START_TIMEOUT_MS,
  SERVICE_START_POLL_INTERVAL_MS,
};

if (require.main === module) {
  run(process.argv).catch((err) => {
    log("ERRO fatal no updater: " + err.message);
    process.exit(1);
  });
}
