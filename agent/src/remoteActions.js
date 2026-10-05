const { execFile: defaultExecFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createWallpaperExecutor } = require("./wallpaper");
const { createDiskCleanupAnalyzer, createSafeDiskCleanupExecutor } = require("./diskCleanupAnalysis");

const ALLOWED_ACTIONS = {
  spooler_reset: true,
  service_restart: true,
  system_maintenance: true,
  set_wallpaper: true,
  disk_cleanup_analyze: true
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
const MAINTENANCE_DETAIL_LIMIT = 50;
const MAX_MAINTENANCE_RESULT_BYTES = 512 * 1024;
const MAX_FINAL_NOTIFICATION_ATTEMPTS = 5;
const FINAL_NOTIFICATION_RETRY_INTERVAL_MS = 30000;

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
    errors: [],
    blockedCount: 0,
    errorsCount: 0,
    truncated: false
  };

  function addDetail(kind, entry) {
    const countKey = `${kind}Count`;
    result[countKey] += 1;
    if (result[kind].length < MAINTENANCE_DETAIL_LIMIT) {
      result[kind].push(entry);
    } else {
      result.truncated = true;
    }
  }

  async function visit(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      addDetail("errors", { path: dir, message: err.message });
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
          if (err.code !== "ENOENT") addDetail("blocked", { path: target, message: err.message });
        }
        continue;
      }

      try {
        await fs.promises.rm(target, { force: true, recursive: false });
        result.filesRemoved += 1;
      } catch (err) {
        addDetail("blocked", { path: target, message: err.message });
      }
    }
  }

  await visit(root);
  return result;
}

function limitSystemMaintenanceResult(result) {
  const fallback = {
    overallStatus: "FAILED",
    steps: [],
    notification: { status: "SKIPPED", message: "Resultado da manutenção não pôde ser serializado." },
    rebootRecommended: true,
    truncated: true,
    truncationMessage: "Resultado da manutenção foi reduzido por segurança."
  };
  try {
    const serialized = JSON.stringify(result);
    if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= MAX_MAINTENANCE_RESULT_BYTES) {
      return result;
    }
  } catch (err) {
    return fallback;
  }

  const compact = {
    overallStatus: result && result.overallStatus === "FAILED" ? "FAILED" : "SUCCESS",
    steps: Array.isArray(result && result.steps)
      ? result.steps.map((step) => ({
        key: step.key,
        status: step.status,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        message: step.message,
        foundCorruption: step.foundCorruption,
        repaired: step.repaired,
        blockedCount: step.blockedCount,
        errorsCount: step.details && step.details.errorsCount
      }))
      : [],
    notification: result && result.notification
      ? {
        status: result.notification.status,
        message: result.notification.message,
        attempts: result.notification.attempts,
        initialReason: result.notification.initialReason,
        delivered: result.notification.delivered
      }
      : { status: "SKIPPED", message: "Notificação não disponível." },
    rebootRecommended: true,
    truncated: true,
    truncationMessage: "Detalhes do resultado foram reduzidos por segurança."
  };
  try {
    if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= MAX_MAINTENANCE_RESULT_BYTES) return compact;
  } catch (err) {
    return fallback;
  }
  return fallback;
}

function normalizeCleanupResult(result) {
  const blocked = Array.isArray(result && result.blocked) ? result.blocked : [];
  const errors = Array.isArray(result && result.errors) ? result.errors : [];
  const blockedCount = result && result.blockedCount != null ? result.blockedCount : blocked.length;
  const errorsCount = result && result.errorsCount != null ? result.errorsCount : errors.length;
  return {
    ...(result || {}),
    blocked: blocked.slice(0, MAINTENANCE_DETAIL_LIMIT),
    errors: errors.slice(0, MAINTENANCE_DETAIL_LIMIT),
    blockedCount,
    errorsCount,
    truncated: !!(result && result.truncated) || blockedCount > MAINTENANCE_DETAIL_LIMIT || errorsCount > MAINTENANCE_DETAIL_LIMIT
  };
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
  const cleanup = deps.cleanupTemp || createSafeDiskCleanupExecutor(deps);
  const runSfc = deps.runSfc || (() => runTool("sfc.exe", ["/scannow"], timeouts.sfcMs));
  const runDism = deps.runDism || (() => runTool("dism.exe", ["/Online", "/Cleanup-Image", "/RestoreHealth"], timeouts.dismMs));
  const flushDns = deps.flushDns || (() => runTool("ipconfig.exe", ["/flushdns"], timeouts.dnsFlushMs));
  const notifyUser = deps.notifyUser;
  const sleep = deps.sleep || ((delayMs) => new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    if (typeof timer.unref === "function") timer.unref();
  }));

  async function notifyWithRetry() {
    if (!notifyUser) {
      return { status: "SKIPPED", message: "Notificação não pôde ser exibida: Notifier indisponível.", attempts: 0, initialReason: "NOTIFIER_UNAVAILABLE", delivered: false };
    }

    let attempts = 0;
    let initialReason = null;
    while (attempts < MAX_FINAL_NOTIFICATION_ATTEMPTS) {
      attempts += 1;
      let notified;
      try {
        notified = await withTimeout(notifyUser(MAINTENANCE_NOTIFICATION), timeouts.notificationMs, "timeout ao exibir notificação");
      } catch (err) {
        return { status: "SKIPPED", message: `Notificação não pôde ser exibida: ${err.message}`, attempts, initialReason: initialReason || "UNEXPECTED_ERROR", delivered: false };
      }

      if (notified && notified.ok !== false) {
        return { status: "SUCCESS", message: "Notificação exibida ao usuário.", attempts, initialReason, delivered: true };
      }

      const reason = notified && notified.reason ? notified.reason : "NOTIFIER_REJECTED";
      initialReason = initialReason || reason;
      if (reason !== "BUSY") {
        return { status: "SKIPPED", message: (notified && notified.message) || "Notifier não aceitou a notificação.", attempts, initialReason, delivered: false };
      }
      if (attempts >= MAX_FINAL_NOTIFICATION_ATTEMPTS) break;
      await sleep(FINAL_NOTIFICATION_RETRY_INTERVAL_MS);
    }

    return {
      status: "SKIPPED",
      message: `Notifier permaneceu ocupado após ${attempts} tentativas.`,
      attempts,
      initialReason,
      delivered: false
    };
  }

  return async function executeSystemMaintenance() {
    const steps = [];
    let hasFailure = false;

    try {
      const startedAt = Date.now();
      const cleanupResult = normalizeCleanupResult(await cleanup());
      if (Date.now() - startedAt > timeouts.tempCleanupMs) {
        cleanupResult.timedOut = true;
        cleanupResult.truncated = true;
        cleanupResult.warnings = Array.isArray(cleanupResult.warnings) ? cleanupResult.warnings : [];
        if (!cleanupResult.warnings.includes("cleanup_timeout")) cleanupResult.warnings.push("cleanup_timeout");
      }
      const blockedCount = cleanupResult.blockedCount;
      const errorCount = cleanupResult.errorsCount;
      const failed = errorCount > 0 || cleanupResult.timedOut;
      hasFailure = hasFailure || failed;
      steps.push({
        key: "temp_cleanup",
        status: failed ? "FAILED" : "SUCCESS",
        durationMs: Date.now() - startedAt,
        message: failed
          ? cleanupResult.timedOut && errorCount === 0
          ? "Limpeza de temporários excedeu o prazo, mas terminou antes da próxima etapa."
          : `Falha ao acessar ${errorCount} local(is) de temporários.`
          : blockedCount
          ? `Limpeza concluída; ${blockedCount} arquivo(s)/diretório(s) em uso foram ignorados.`
          : "Temporários do usuário e do Windows limpos.",
        blockedCount,
        errorsCount: errorCount,
        timedOut: !!cleanupResult.timedOut,
        truncated: !!cleanupResult.truncated,
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

    const notification = await notifyWithRetry();

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
  const analyzeDiskCleanup = deps.analyzeDiskCleanup || createDiskCleanupAnalyzer(deps);
  const executeWallpaper = deps.executeWallpaper || createWallpaperExecutor(deps);
  const store = deps.store || null;
  const state = new Map();
  let maintenanceRunning = false;

  function persist(execution) {
    if (!store) return true;
    const ok = store.upsert(execution);
    if (!ok) logEvent("remote_action_storage_unavailable " + execution.actionExecutionId);
    return ok;
  }

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
      persist(rejected);
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
      persist(rejected);
      send(ws, rejected);
      return snapshot(rejected);
    }

    const existing = state.get(actionExecutionId) || (store && store.get(actionExecutionId));
    if (existing && ["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(existing.status)) {
      if (existing.action && existing.action !== action) {
        const rejected = {
          actionExecutionId,
          action,
          status: "REJECTED",
          message: "O actionExecutionId já pertence a outra ação.",
          error: "actionExecutionId duplicado com action diferente."
        };
        send(ws, rejected);
        return snapshot(rejected);
      }
      state.set(actionExecutionId, existing);
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
      persist(rejected);
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
        : action === "disk_cleanup_analyze"
        ? "Analisando espaço potencialmente recuperável."
        : action === "set_wallpaper"
        ? "Baixando e aplicando papel de parede padrão."
        : "Executando reset do spooler.",
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      updatedAt: new Date().toISOString()
    };
    state.set(actionExecutionId, running);
    if (!persist(running)) {
      const failed = {
        ...running,
        status: "FAILED",
        message: "Não foi possível persistir o estado local antes da execução.",
        error: "remote action storage unavailable",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.set(actionExecutionId, failed);
      send(ws, failed);
      if (action === "system_maintenance") maintenanceRunning = false;
      return snapshot(failed);
    }
    send(ws, running);

    try {
      const result = action === "service_restart"
        ? await executeServiceRestart(serviceKey)
        : action === "system_maintenance"
          ? await executeSystemMaintenance()
        : action === "disk_cleanup_analyze"
          ? await analyzeDiskCleanup()
        : action === "set_wallpaper"
        ? await executeWallpaper(msg.payload, deps.applyWallpaper)
        : action === "disk_cleanup_analyze"
        ? await analyzeDiskCleanup()
        : await executeSpoolerReset();
      const safeResult = action === "system_maintenance" ? limitSystemMaintenanceResult(result) : result;
      if (action === "system_maintenance" && safeResult && safeResult.overallStatus === "FAILED") {
        const failed = {
          actionExecutionId,
          action,
          status: "FAILED",
          message: "Manutenção concluída com falhas em uma ou mais etapas.",
          error: null,
          result: safeResult,
          startedAt: running.startedAt,
          finishedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        state.set(actionExecutionId, failed);
        persist(failed);
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
          : action === "disk_cleanup_analyze"
          ? "Análise de disco concluída."
          : action === "set_wallpaper"
          ? "Papel de parede aplicado com sucesso."
          : "Spooler reiniciado com sucesso.",
        error: null,
        result: safeResult || { spooler: "restarted" },
        startedAt: running.startedAt,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.set(actionExecutionId, success);
      persist(success);
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
        error: e && e.message ? e.message : String(e),
        startedAt: running.startedAt,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      state.set(actionExecutionId, failed);
      persist(failed);
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

  function getReconciliationRecords() {
    return store ? store.reconciliationRecords() : [];
  }

  function markConfirmed(actionExecutionId, status) {
    return !!store && store.markConfirmed(actionExecutionId, status);
  }

  return {
    handleRemoteAction,
    getExecution,
    resetForTests,
    getReconciliationRecords,
    markConfirmed,
    executeSpoolerReset,
    executeSystemMaintenance,
    executeWallpaper
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
  limitSystemMaintenanceResult,
  MAX_MAINTENANCE_RESULT_BYTES,
  MAX_FINAL_NOTIFICATION_ATTEMPTS,
  FINAL_NOTIFICATION_RETRY_INTERVAL_MS,
  createRemoteActionRuntime,
  ...defaultRuntime
};
