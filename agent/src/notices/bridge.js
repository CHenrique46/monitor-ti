const { createNotifier: defaultCreateNotifier } = require("../notifier");
const { createNoticeRuntime: defaultCreateNoticeRuntime } = require("./runtime");
const { queryTaskState: defaultQueryTaskState, runTask: defaultRunTask } = require("./task");
const { composeCapabilities } = require("../capabilities");

const COMPANION_TASK_NAME = "MonitorTI-Notifier";
const RECOVERY_GRACE_PERIOD_MS = 5000;
const RECOVERY_COOLDOWN_MS = 60000;
const RECOVERY_BACKOFF_INITIAL_MS = 15000;
const RECOVERY_BACKOFF_MAX_MS = 300000;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_MAX_ATTEMPTS = 3;

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
    companionEnabled = isCompanionEnabled(process.env.MTI_NOTICES_COMPANION, version),
    recoveryGracePeriodMs = RECOVERY_GRACE_PERIOD_MS,
    recoveryCooldownMs = RECOVERY_COOLDOWN_MS,
    recoveryBackoffInitialMs = RECOVERY_BACKOFF_INITIAL_MS,
    recoveryBackoffMaxMs = RECOVERY_BACKOFF_MAX_MS,
    recoveryWindowMs = RECOVERY_WINDOW_MS,
    recoveryMaxAttempts = RECOVERY_MAX_ATTEMPTS
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
  const recovery = {
    timer: null,
    inFlight: false,
    cooldownUntil: 0,
    windowStartedAt: 0,
    attempts: 0,
    backoffMs: recoveryBackoffInitialMs,
    ready: false
  };

  function log(message) {
    if (typeof logEvent === "function") logEvent(message);
  }

  function capabilities() {
    const notifier = companionEnabled ? runtime : legacyNotifier;
    return composeCapabilities({ version, notifier });
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

  function clearRecoveryTimer() {
    if (recovery.timer) clearTimeout(recovery.timer);
    recovery.timer = null;
  }

  function resetRecovery() {
    clearRecoveryTimer();
    recovery.inFlight = false;
    recovery.cooldownUntil = 0;
    recovery.windowStartedAt = 0;
    recovery.attempts = 0;
    recovery.backoffMs = recoveryBackoffInitialMs;
  }

  function scheduleRecovery(reason, delayMs = recoveryGracePeriodMs, allowCooldown = false) {
    if (!companionEnabled || recovery.ready || recovery.inFlight || recovery.timer) return false;
    if (typeof getInteractiveUser === "function" && !String(getInteractiveUser() || "").trim()) {
      log("companion_recovery_skipped reason=no_interactive_session");
      return false;
    }
    const now = Date.now();
    if (!allowCooldown && now < recovery.cooldownUntil) {
      log("companion_recovery_skipped reason=cooldown");
      return false;
    }
    if (recovery.windowStartedAt && now - recovery.windowStartedAt >= recoveryWindowMs) {
      recovery.windowStartedAt = 0;
      recovery.attempts = 0;
      recovery.backoffMs = recoveryBackoffInitialMs;
    }
    if (recovery.attempts >= recoveryMaxAttempts) {
      log("companion_recovery_skipped reason=max_attempts");
      return false;
    }
    log("companion_recovery_scheduled reason=" + reason);
    if (delayMs === 0) return recoverCompanion(reason);
    recovery.timer = setTimeout(() => {
      recovery.timer = null;
      recoverCompanion(reason);
    }, Math.max(0, delayMs));
    if (recovery.timer && typeof recovery.timer.unref === "function") recovery.timer.unref();
    return true;
  }

  function recoverCompanion(reason) {
    if (recovery.ready || recovery.inFlight) return false;
    if (typeof getInteractiveUser === "function" && !String(getInteractiveUser() || "").trim()) {
      log("companion_recovery_skipped reason=no_interactive_session");
      return false;
    }
    const now = Date.now();
    if (now < recovery.cooldownUntil) {
      log("companion_recovery_skipped reason=cooldown");
      return false;
    }
    if (!recovery.windowStartedAt || now - recovery.windowStartedAt >= recoveryWindowMs) {
      recovery.windowStartedAt = now;
      recovery.attempts = 0;
      recovery.backoffMs = recoveryBackoffInitialMs;
    }
    if (recovery.attempts >= recoveryMaxAttempts) {
      log("companion_recovery_skipped reason=max_attempts");
      return false;
    }
    const q = queryCompanionTask();
    if (!q.ok) {
      log("companion_recovery_failed reason=task_unavailable");
      return false;
    }
    recovery.inFlight = true;
    recovery.attempts += 1;
    log("companion_recovery_attempt reason=" + reason);
    try {
      runTask();
      recovery.cooldownUntil = Date.now() + recoveryCooldownMs;
      log("companion_recovery_success reason=" + reason);
      recovery.inFlight = false;
      scheduleRecovery(reason, recoveryCooldownMs, true);
      return true;
    } catch (err) {
      recovery.inFlight = false;
      log("companion_recovery_failed reason=task_run_error");
      const delay = recovery.backoffMs;
      recovery.backoffMs = Math.min(recoveryBackoffMaxMs, recovery.backoffMs * 2);
      scheduleRecovery(reason, delay);
      return false;
    }
  }

  function handleRuntimeCapabilityChange(nextCapabilities, reason) {
    const ready = Array.isArray(nextCapabilities) && nextCapabilities.includes("notices");
    recovery.ready = ready;
    if (ready) resetRecovery();
    else scheduleRecovery(reason === "heartbeat_timeout" ? "heartbeat_timeout" : "disconnect");
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

  function handleServerMessageResult(ws, msg) {
    if (!msg || typeof msg !== "object") return { accepted: false, reason: "INVALID_PAYLOAD" };
    if (msg.type !== "notice_show") return { accepted: false, reason: "INVALID_PAYLOAD" };

    if (companionEnabled) {
      if (!runtime) return { accepted: false, reason: "NOTIFIER_UNAVAILABLE" };
      const payload = msg.data && typeof msg.data === "object" ? msg.data : msg;
      if (typeof runtime.enqueueFromServerResult === "function") return runtime.enqueueFromServerResult(payload);
      return { accepted: !!runtime.enqueueFromServer(payload), reason: "NOTIFIER_REJECTED" };
    }

    if (!legacyNotifier) return { accepted: false, reason: "NOTIFIER_UNAVAILABLE" };
    return { accepted: legacyNotifier.handleNoticeShow(ws, msg) !== false };
  }

  function handleServerMessage(ws, msg) {
    return handleServerMessageResult(ws, msg).accepted;
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
    return scheduleRecovery("startup", 0);
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
    handleServerMessageResult,
    announceCapabilities,
    shutdownForUpdate,
    attemptCompanionTaskRunIfNeeded,
    queryCompanionTask,
    getRecoveryState: () => ({ ...recovery }),
    shutdown,
    isNotifierReady,
    getReadinessStatus,
    applyWallpaper,
    getRuntimeState
  };
}

module.exports = { createNoticeBridge, isCompanionEnabled };
