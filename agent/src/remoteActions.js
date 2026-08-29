const { execFile: defaultExecFile } = require("child_process");

const ALLOWED_ACTIONS = {
  spooler_reset: true
};

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

function createRemoteActionRuntime(deps = {}) {
  const getDeviceId = deps.getDeviceId || (() => null);
  const logEvent = deps.logEvent || (() => {});
  const executeSpoolerReset = deps.executeSpoolerReset || createSpoolerResetExecutor(deps);
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

    const existing = state.get(actionExecutionId);
    if (existing && ["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(existing.status)) {
      send(ws, existing);
      return snapshot(existing);
    }

    const running = {
      actionExecutionId,
      action,
      status: "RUNNING",
      message: "Executando reset do spooler.",
      error: null
    };
    state.set(actionExecutionId, running);
    send(ws, running);

    try {
      const result = await executeSpoolerReset();
      const success = {
        actionExecutionId,
        action,
        status: "SUCCESS",
        message: "Spooler reiniciado com sucesso.",
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
  withTimeout,
  createSpoolerResetExecutor,
  createRemoteActionRuntime,
  ...defaultRuntime
};
