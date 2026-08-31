const { execFile: defaultExecFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ALLOWED_ACTIONS = {
  spooler_reset: true,
  service_restart: true,
  system_maintenance: true
};

const SERVICE_ALLOWLIST = Object.freeze({
  spooler: Object.freeze({
    serviceName: "Spooler",
    displayName: "Spooler de Impressão"
  })
});

const SYSTEM_MAINTENANCE_TIMEOUTS = Object.freeze({
  tempCleanupMs: 120000,
  sfcMs: 1800000,
  dismMs: 3600000,
  dnsFlushMs: 30000,
  notificationMs: 10000
});

const MAINTENANCE_NOTIFICATION = Object.freeze({
  title: "Manutenção do computador concluída",
  message: "A manutenção preventiva do sistema foi finalizada.\nPara concluir o processo, recomendamos reiniciar o computador.",
  level: "info"
});

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage || "timeout")), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function createSpoolerResetExecutor(deps = {}) {
  const execFile = deps.execFile || defaultExecFile;
  const timeoutMs = deps.timeoutMs || 30000;
  const stopService = deps.stopService || (() => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Stop-Service -Name Spooler -Force -ErrorAction Stop"], { windowsHide: true, timeout: timeoutMs }));
  const clearPrintQueue = deps.clearPrintQueue || (() => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", 'Remove-Item -Path "$env:WINDIR\\System32\\spool\\PRINTERS\\*" -Force -ErrorAction Stop'], { windowsHide: true, timeout: timeoutMs }));
  const startService = deps.startService || (() => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Start-Service -Name Spooler -ErrorAction Stop"], { windowsHide: true, timeout: timeoutMs }));

  return async function executeSpoolerReset() {
    let stopErr = null;
    let clearErr = null;
    let startErr = null;

    const run = (async () => {
      try {
        await stopService();
      } catch (e) {
        stopErr = e;
      }

      try {
        await clearPrintQueue();
      } catch (e) {
        clearErr = e;
      }

      try {
        await startService();
      } catch (e) {
        startErr = e;
      }

      if (stopErr || clearErr || startErr) {
        const err = new Error(
          stopErr
            ? `falha ao parar Spooler: ${stopErr.message}`
            : clearErr
            ? `falha ao limpar fila: ${clearErr.message}`
            : `falha ao iniciar Spooler: ${startErr.message}`
        );
        err.stopErr = stopErr;
        err.clearErr = clearErr;
        err.startErr = startErr;
        throw err;
      }

      return { spooler: "restarted" };
    })();

    return withTimeout(run, timeoutMs, "timeout ao executar spooler_reset");
  };
}

function createServiceRestartExecutor(serviceKey, deps = {}) {
  const service = SERVICE_ALLOWLIST[serviceKey];
  if (!service) throw new Error("Serviço não permitido.");

  const execFile = deps.execFile || defaultExecFile;
  const timeoutMs = deps.timeoutMs || 30000;
  const runCommand = deps.runCommand || ((file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  }));
  const command = (script) => runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: timeoutMs });
  const stopService = deps.stopService || (() => command(`Stop-Service -Name ${service.serviceName} -Force -ErrorAction Stop`));
  const startService = deps.startService || (() => command(`Start-Service -Name ${service.serviceName} -ErrorAction Stop`));
  const getServiceStatus = deps.getServiceStatus || (async () => {
    const result = await command(`(Get-Service -Name ${service.serviceName} -ErrorAction Stop).Status.ToString()`);
    return result && result.stdout;
  });

  return async function executeServiceRestart() {
    let stopErr = null;
    let startErr = null;
    let status = null;

    const run = (async () => {
      try {
        await stopService();
      } catch (e) {
        stopErr = e;
      }

      try {
        await startService();
      } catch (e) {
        startErr = e;
      }

      try {
        status = String(await getServiceStatus()).trim();
      } catch (e) {
        status = null;
        if (!startErr) startErr = e;
      }

      if (stopErr || startErr || status !== "Running") {
        const err = new Error(
          stopErr
            ? `falha ao parar ${service.displayName}: ${stopErr.message}`
            : startErr
            ? `falha ao iniciar ${service.displayName}: ${startErr.message}`
            : `${service.displayName} não está Running após a reinicialização`
        );
        err.stopErr = stopErr;
        err.startErr = startErr;
        err.status = status;
        throw err;
      }

      return { serviceKey, serviceName: service.serviceName, displayName: service.displayName, status };
    })();

    return withTimeout(run, timeoutMs, "timeout ao executar service_restart");
  };
}

async function removeDirectoryContents(root) {
  const result = {
    root,
    filesRemoved: 0,
    directoriesRemoved: 0,
    blocked: [],
    errors: []
  };

  async function visit(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      result.errors.push({ path: dir, message: err.message });
      return;
    }

    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(target);
        try {
          await fs.promises.rmdir(target);
          result.directoriesRemoved += 1;
        } catch (err) {
          if (err.code !== "ENOENT" && err.code !== "ENOTEMPTY") {
            result.blocked.push({ path: target, message: err.message });
          }
        }
        continue;
      }

      try {
        await fs.promises.rm(target, { force: true, recursive: false });
        result.filesRemoved += 1;
      } catch (err) {
        result.blocked.push({ path: target, message: err.message });
      }
    }
  }

  await visit(root);
  return result;
}

function maintenanceCommandResult(result, startedAt) {
  const stdout = result && result.stdout ? String(result.stdout) : "";
  const stderr = result && result.stderr ? String(result.stderr) : "";
  const rawExitCode = result && result.exitCode;
  const exitCode = rawExitCode == null ? 0 : Number.isFinite(Number(rawExitCode)) ? Number(rawExitCode) : null;
  return {
    exitCode,
    durationMs: result && result.durationMs != null ? result.durationMs : Date.now() - startedAt,
    stdout,
    stderr,
    timedOut: !!(result && result.timedOut)
  };
}

function maintenanceOutput(result) {
  const limit = 4000;
  return {
    stdout: result.stdout.slice(0, limit),
    stderr: result.stderr.slice(0, limit)
  };
}

function classifySfc(result) {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return {
    foundCorruption: /corrupt|corrupted|integrity violation|corrup/.test(output) ? true : null,
    repaired: /successfully repaired|repaired them|reparad|reparou/.test(output) ? true : null
  };
}

function createSystemMaintenanceExecutor(deps = {}) {
  const timeouts = { ...SYSTEM_MAINTENANCE_TIMEOUTS, ...(deps.timeouts || {}) };
  const execFile = deps.execFile || defaultExecFile;
  const runCommand = deps.runCommand || ((file, args, options) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    execFile(file, args, options, (err, stdout, stderr) => {
      const result = {
        exitCode: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut: !!(err && (err.killed || err.code === "ETIMEDOUT"))
      };
      if (err) {
        err.result = result;
        reject(err);
        return;
      }
      resolve(result);
    });
  }));
  const runTool = async (file, args, timeoutMs) => {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        runCommand(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }),
        timeoutMs,
        `timeout ao executar ${file}`
      );
      return maintenanceCommandResult(result, startedAt);
    } catch (err) {
      return maintenanceCommandResult(
        err && err.result
          ? err.result
          : { exitCode: typeof err.code === "number" ? err.code : null, stderr: err.message, timedOut: /timeout/i.test(err.message || "") },
        startedAt
      );
    }
  };
  const cleanup = deps.cleanupTemp || (async () => {
    const userTemp = deps.userTempPath || process.env.TEMP || process.env.TMP || os.tmpdir();
    const windowsTemp = deps.windowsTempPath || path.join(process.env.WINDIR || "C:\\Windows", "Temp");
    const user = await removeDirectoryContents(userTemp);
    const windows = await removeDirectoryContents(windowsTemp);
    return { roots: [user, windows], blocked: [...user.blocked, ...windows.blocked], errors: [...user.errors, ...windows.errors] };
  });
  const runSfc = deps.runSfc || (() => runTool("sfc.exe", ["/scannow"], timeouts.sfcMs));
  const runDism = deps.runDism || (() => runTool("dism.exe", ["/Online", "/Cleanup-Image", "/RestoreHealth"], timeouts.dismMs));
  const flushDns = deps.flushDns || (() => runTool("ipconfig.exe", ["/flushdns"], timeouts.dnsFlushMs));
  const notifyUser = deps.notifyUser;

  return async function executeSystemMaintenance() {
    const steps = [];
    let hasFailure = false;

    try {
      const startedAt = Date.now();
      const cleanupResult = await withTimeout(cleanup(), timeouts.tempCleanupMs, "timeout ao limpar temporarios");
      const blockedCount = cleanupResult.blocked ? cleanupResult.blocked.length : 0;
      const errorCount = cleanupResult.errors ? cleanupResult.errors.length : 0;
      const failed = errorCount > 0;
      hasFailure = hasFailure || failed;
      steps.push({
        key: "temp_cleanup",
        status: failed ? "FAILED" : "SUCCESS",
        durationMs: Date.now() - startedAt,
        message: failed
          ? `Falha ao acessar ${errorCount} local(is) de temporários.`
          : blockedCount
          ? `Limpeza concluída; ${blockedCount} arquivo(s)/diretório(s) em uso foram ignorados.`
          : "Temporários do usuário e do Windows limpos.",
        blockedCount,
        details: cleanupResult
      });
    } catch (err) {
      hasFailure = true;
      steps.push({ key: "temp_cleanup", status: "FAILED", durationMs: timeouts.tempCleanupMs, message: err.message });
    }

    const sfc = await runSfc();
    const sfcInfo = classifySfc(sfc);
    if (sfc.exitCode !== 0 || sfc.timedOut) hasFailure = true;
    steps.push({
      key: "sfc",
      status: sfc.exitCode === 0 && !sfc.timedOut ? "SUCCESS" : "FAILED",
      durationMs: sfc.durationMs,
      exitCode: sfc.exitCode,
      message: sfc.timedOut ? "SFC excedeu o tempo limite." : sfc.exitCode === 0 ? "SFC concluído." : "SFC falhou.",
      output: maintenanceOutput(sfc),
      ...sfcInfo
    });

    const dism = await runDism();
    if (dism.exitCode !== 0 || dism.timedOut) hasFailure = true;
    steps.push({
      key: "dism",
      status: dism.exitCode === 0 && !dism.timedOut ? "SUCCESS" : "FAILED",
      durationMs: dism.durationMs,
      exitCode: dism.exitCode,
      message: dism.timedOut ? "DISM excedeu o tempo limite." : dism.exitCode === 0 ? "DISM concluído." : "DISM falhou.",
      output: maintenanceOutput(dism)
    });

    const dns = await flushDns();
    if (dns.exitCode !== 0 || dns.timedOut) hasFailure = true;
    steps.push({
      key: "dns_flush",
      status: dns.exitCode === 0 && !dns.timedOut ? "SUCCESS" : "FAILED",
      durationMs: dns.durationMs,
      exitCode: dns.exitCode,
      message: dns.timedOut ? "Flush DNS excedeu o tempo limite." : dns.exitCode === 0 ? "Cache DNS limpo." : "Flush DNS falhou.",
      output: maintenanceOutput(dns)
    });

    let notification = { status: "SKIPPED", message: "Notificação não pôde ser exibida: Notifier indisponível." };
    if (notifyUser) {
      try {
        const notified = await withTimeout(notifyUser(MAINTENANCE_NOTIFICATION), timeouts.notificationMs, "timeout ao exibir notificação");
        notification = notified && notified.ok === false
          ? { status: "SKIPPED", message: notified.message || "Notificação não pôde ser exibida." }
          : { status: "SUCCESS", message: "Notificação exibida ao usuário." };
      } catch (err) {
        notification = { status: "SKIPPED", message: `Notificação não pôde ser exibida: ${err.message}` };
      }
    }

    return {
      overallStatus: hasFailure ? "FAILED" : "SUCCESS",
      steps,
      notification,
      rebootRecommended: true
    };
  };
}

function createRemoteActionRuntime(deps = {}) {
  const getDeviceId = deps.getDeviceId || (() => null);
  const logEvent = deps.logEvent || (() => {});
  const executeSpoolerReset = deps.executeSpoolerReset || createSpoolerResetExecutor(deps);
  const executeServiceRestart = deps.executeServiceRestart || ((serviceKey) => {
    const executor = createServiceRestartExecutor(serviceKey, deps);
    return executor();
  });
  const executeSystemMaintenance = deps.executeSystemMaintenance || createSystemMaintenanceExecutor(deps);
  const state = new Map();
  let maintenanceRunning = false;

  function send(ws, payload) {
    if (!ws || ws.readyState !== 1 || typeof ws.send !== "function") return false;
    try {
      ws.send(JSON.stringify({
        type: "remote_action_status",
        protocolVersion: 1,
        deviceId: getDeviceId(),
        timestamp: new Date().toISOString(),
        ...payload
      }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function snapshot(execution) {
    return execution ? { ...execution } : null;
  }

  async function handleRemoteAction(ws, msg) {
    const actionExecutionId = String((msg && msg.actionExecutionId) || "").trim();
    const action = String((msg && msg.action) || "").trim().toLowerCase();

    if (!actionExecutionId || !ALLOWED_ACTIONS[action]) {
      const rejected = {
        actionExecutionId: actionExecutionId || null,
        action: action || null,
        status: "REJECTED",
        message: "Ação remota não suportada.",
        error: null
      };
      state.set(actionExecutionId || `invalid:${Date.now()}`, rejected);
      send(ws, rejected);
      return snapshot(rejected);
    }

    const serviceKey = String(msg && msg.payload && msg.payload.serviceKey || "").trim().toLowerCase();
    if (action === "service_restart" && !SERVICE_ALLOWLIST[serviceKey]) {
      const rejected = {
        actionExecutionId,
        action,
        status: "REJECTED",
        message: "Serviço não permitido.",
        error: null
      };
      state.set(actionExecutionId, rejected);
      send(ws, rejected);
      return snapshot(rejected);
    }

    const existing = state.get(actionExecutionId);
    if (existing && ["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(existing.status)) {
      send(ws, existing);
      return snapshot(existing);
    }
    if (action === "system_maintenance" && maintenanceRunning) {
      const rejected = {
        actionExecutionId,
        action,
        status: "REJECTED",
        message: "Já existe uma manutenção do sistema em execução.",
        error: "system_maintenance em execução"
      };
      state.set(actionExecutionId, rejected);
      send(ws, rejected);
      return snapshot(rejected);
    }
    if (action === "system_maintenance") maintenanceRunning = true;

    const running = {
      actionExecutionId,
      action,
      status: "RUNNING",
      message: action === "service_restart"
        ? `Reiniciando ${SERVICE_ALLOWLIST[serviceKey].displayName}.`
        : action === "system_maintenance"
        ? "Executando manutenção preventiva do Windows."
        : "Executando reset do spooler.",
      error: null
    };
    state.set(actionExecutionId, running);
    send(ws, running);

    try {
      const result = action === "service_restart"
        ? await executeServiceRestart(serviceKey)
        : action === "system_maintenance"
        ? await executeSystemMaintenance()
        : await executeSpoolerReset();
      if (action === "system_maintenance" && result && result.overallStatus === "FAILED") {
        const failed = {
          actionExecutionId,
          action,
          status: "FAILED",
          message: "Manutenção concluída com falhas em uma ou mais etapas.",
          error: null,
          result
        };
        state.set(actionExecutionId, failed);
        send(ws, failed);
        return snapshot(failed);
      }
      const success = {
        actionExecutionId,
        action,
        status: "SUCCESS",
        message: action === "service_restart"
          ? `${SERVICE_ALLOWLIST[serviceKey].displayName} reiniciado com sucesso.`
          : action === "system_maintenance"
          ? "Manutenção preventiva concluída. Reinicialização recomendada."
          : "Spooler reiniciado com sucesso.",
        error: null,
        result: result || { spooler: "restarted" }
      };
      state.set(actionExecutionId, success);
      send(ws, success);
      return snapshot(success);
    } catch (e) {
      const failed = {
        actionExecutionId,
        action,
        status: "FAILED",
        message: e && e.message
          ? e.message.replace(/\s+stack:\s*[\s\S]*$/i, "")
          : action === "system_maintenance"
          ? "Falha na manutenção preventiva."
          : "Falha ao reiniciar spooler.",
        error: e && e.message ? e.message : String(e)
      };
      state.set(actionExecutionId, failed);
      send(ws, failed);
      logEvent("remote_action_failed " + actionExecutionId + ": " + failed.message);
      return snapshot(failed);
    } finally {
      if (action === "system_maintenance") maintenanceRunning = false;
    }
  }

  function getExecution(actionExecutionId) {
    return snapshot(state.get(String(actionExecutionId)) || null);
  }

  function resetForTests() {
    state.clear();
  }

  return {
    handleRemoteAction,
    getExecution,
    resetForTests,
    executeSpoolerReset,
    executeSystemMaintenance
  };
}

const defaultRuntime = createRemoteActionRuntime();

module.exports = {
  ALLOWED_ACTIONS,
  SERVICE_ALLOWLIST,
  withTimeout,
  createSpoolerResetExecutor,
  createServiceRestartExecutor,
  createSystemMaintenanceExecutor,
  createRemoteActionRuntime,
  ...defaultRuntime
};
