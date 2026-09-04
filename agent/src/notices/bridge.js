const { createNotifier: defaultCreateNotifier } = require("../notifier");
const { createNoticeRuntime: defaultCreateNoticeRuntime } = require("./runtime");
const { queryTaskState: defaultQueryTaskState, runTask: defaultRunTask } = require("./task");

const COMPANION_TASK_NAME = "MonitorTI-Notifier";

function compareVersion(a, b) {
  const pa = String(a || "0").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function isCompanionEnabled(value, version) {
  const raw = String(value || "").trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return compareVersion(version, "1.1.8") >= 0;
}

function createNoticeBridge(opts, deps = {}) {
  const {
    configDir,
    getAppDir,
    getDeviceId,
    getServerHttpBase,
    logEvent,
    version,
    getInteractiveUser,
    processInfoLookup,
    companionEnabled = isCompanionEnabled(process.env.MTI_NOTICES_COMPANION, version)
  } = opts;

  const createNotifier = deps.createNotifier || defaultCreateNotifier;
  const createNoticeRuntime = deps.createNoticeRuntime || defaultCreateNoticeRuntime;
  const execFileSyncImpl = deps.execFileSync;
  const queryTaskState = deps.queryTaskState || (() => defaultQueryTaskState(execFileSyncImpl));
  const runTask = deps.runTask || (() => defaultRunTask(execFileSyncImpl));

  let currentWs = null;
  let lastCapabilitiesKey = null;
  let legacyStarted = false;
  let legacyEnsureStarted = false;
  let runtime = null;
  let legacyNotifier = null;
  let taskRunAttempted = false;

  function log(message) {
    if (typeof logEvent === "function") logEvent(message);
  }

  function capabilities() {
    const ready = companionEnabled
      ? !!(runtime && typeof runtime.isNotifierReady === "function" && runtime.isNotifierReady())
      : !!(legacyNotifier && typeof legacyNotifier.isNotifierReady === "function" && legacyNotifier.isNotifierReady());
    return ready ? ["notices"] : [];
  }

  function sendServerEvent(evt) {
    if (!evt || !evt.type) return false;
    const ws = currentWs;
    if (!ws || ws.readyState !== 1 || typeof ws.send !== "function") return false;
    try {
      ws.send(JSON.stringify(evt));
      return true;
    } catch {
      return false;
    }
  }

  function announceCapabilities(force = false) {
    const ws = currentWs;
    if (!ws || ws.readyState !== 1 || typeof ws.send !== "function") return false;
    const current = capabilities();
    const key = current.join(",");
    if (!force && key === lastCapabilitiesKey) return false;
    lastCapabilitiesKey = key;
    try {
      ws.send(
        JSON.stringify({
          type: "capabilities",
          deviceId: typeof getDeviceId === "function" ? getDeviceId() : null,
          data: { capabilities: current }
        })
      );
      log("Capabilities enviadas: " + (current.length ? current.join(",") : "nenhuma"));
      return true;
    } catch (err) {
      log("Erro ao enviar capabilities: " + err.message);
      return false;
    }
  }

  function handleRuntimeCapabilityChange() {
    announceCapabilities(false);
  }

  if (companionEnabled) {
    runtime = createNoticeRuntime({
      configDir,
      getDeviceId,
      getAppDir,
      logEvent,
      version,
      getInteractiveUser,
      onCapabilityChange: handleRuntimeCapabilityChange,
      onServerEvent: sendServerEvent,
      processInfoLookup
    });
    runtime.start();
  } else {
    legacyNotifier = createNotifier({
      configDir,
      getAppDir,
      getDeviceId,
      getWs: () => currentWs,
      logEvent,
      version,
      getServerHttpBase,
      onNotifierReady: () => announceCapabilities(true)
    });
  }

  function onWsOpen(ws) {
    currentWs = ws;
    lastCapabilitiesKey = null;

    if (!companionEnabled && legacyNotifier) {
      if (!legacyEnsureStarted) {
        legacyEnsureStarted = true;
        legacyNotifier.ensureNotifierPresent();
      }
      if (!legacyStarted) {
        legacyStarted = true;
        legacyNotifier.start(ws);
      }
    }

    announceCapabilities(true);
  }

  function onWsClose(ws) {
    if (currentWs === ws) {
      currentWs = null;
      lastCapabilitiesKey = null;
    }
  }

  function handleServerMessage(ws, msg) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type !== "notice_show") return false;

    if (companionEnabled) {
      if (!runtime) return false;
      const payload = msg.data && typeof msg.data === "object" ? msg.data : msg;
      return !!runtime.enqueueFromServer(payload);
    }

    if (!legacyNotifier) return false;
    legacyNotifier.handleNoticeShow(ws, msg);
    return true;
  }

  function shutdown() {
    if (runtime && typeof runtime.stop === "function") {
      runtime.stop();
    }
  }

  async function shutdownForUpdate() {
    if (!companionEnabled || !runtime || typeof runtime.requestShutdown !== "function") return false;
    return runtime.requestShutdown("update", 10000);
  }

  function queryCompanionTask() {
    try {
      const state = queryTaskState();
      if (!state || state.exists === false) return { ok: false, error: "task ausente" };
      return { ok: true, output: state };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  function attemptCompanionTaskRunIfNeeded() {
    if (taskRunAttempted || !companionEnabled) return false;
    taskRunAttempted = true;
    if (typeof getInteractiveUser === "function" && !String(getInteractiveUser() || "").trim()) {
      return false;
    }
    const q = queryCompanionTask();
    if (!q.ok) return false;
    try {
      runTask();
      log("scheduled task run solicitado: " + COMPANION_TASK_NAME);
      return true;
    } catch (err) {
      log("falha ao solicitar task run: " + err.message);
      return false;
    }
  }

  function isNotifierReady() {
    return capabilities().length > 0;
  }

  function getReadinessStatus() {
    if (companionEnabled) {
      return runtime && typeof runtime.getReadinessStatus === "function"
        ? runtime.getReadinessStatus()
        : { status: "UNKNOWN" };
    }
    return legacyNotifier && typeof legacyNotifier.getReadinessStatus === "function"
      ? legacyNotifier.getReadinessStatus()
      : { status: "UNKNOWN" };
  }

  function applyWallpaper(payload) {
    if (!companionEnabled || !runtime || typeof runtime.requestWallpaper !== "function") {
      return Promise.reject(new Error("Companion indisponível."));
    }
    return runtime.requestWallpaper(payload);
  }

  function getRuntimeState() {
    return runtime && typeof runtime.getState === "function" ? runtime.getState() : null;
  }

  return {
    isCompanionMode: companionEnabled,
    onWsOpen,
    onWsClose,
    handleServerMessage,
    announceCapabilities,
    shutdownForUpdate,
    attemptCompanionTaskRunIfNeeded,
    queryCompanionTask,
    shutdown,
    isNotifierReady,
    getReadinessStatus,
    applyWallpaper,
    getRuntimeState
  };
}

module.exports = { createNoticeBridge, isCompanionEnabled };
