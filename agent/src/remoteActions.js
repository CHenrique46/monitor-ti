const { execFile: defaultExecFile } = require("child_process");

const ALLOWED_ACTIONS = {
  spooler_reset: true,
  service_restart: true
};

const SERVICE_ALLOWLIST = Object.freeze({
  spooler: Object.freeze({
    serviceName: "Spooler",
    displayName: "Spooler de Impressão"
  })
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

function createRemoteActionRuntime(deps = {}) {
  const getDeviceId = deps.getDeviceId || (() => null);
  const logEvent = deps.logEvent || (() => {});
  const executeSpoolerReset = deps.executeSpoolerReset || createSpoolerResetExecutor(deps);
  const executeServiceRestart = deps.executeServiceRestart || ((serviceKey) => {
    const executor = createServiceRestartExecutor(serviceKey, deps);
    return executor();
  });
  const state = new Map();

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

    const running = {
      actionExecutionId,
      action,
      status: "RUNNING",
      message: action === "service_restart"
        ? `Reiniciando ${SERVICE_ALLOWLIST[serviceKey].displayName}.`
        : "Executando reset do spooler.",
      error: null
    };
    state.set(actionExecutionId, running);
    send(ws, running);

    try {
      const result = action === "service_restart"
        ? await executeServiceRestart(serviceKey)
        : await executeSpoolerReset();
      const success = {
        actionExecutionId,
        action,
        status: "SUCCESS",
        message: action === "service_restart"
          ? `${SERVICE_ALLOWLIST[serviceKey].displayName} reiniciado com sucesso.`
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
        message: e && e.message ? e.message.replace(/\s+stack:\s*[\s\S]*$/i, "") : "Falha ao reiniciar spooler.",
        error: e && e.message ? e.message : String(e)
      };
      state.set(actionExecutionId, failed);
      send(ws, failed);
      logEvent("remote_action_failed " + actionExecutionId + ": " + failed.message);
      return snapshot(failed);
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
    executeSpoolerReset
  };
}

const defaultRuntime = createRemoteActionRuntime();

module.exports = {
  ALLOWED_ACTIONS,
  SERVICE_ALLOWLIST,
  withTimeout,
  createSpoolerResetExecutor,
  createServiceRestartExecutor,
  createRemoteActionRuntime,
  ...defaultRuntime
};
