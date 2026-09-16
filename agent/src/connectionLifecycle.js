const DEFAULTS = Object.freeze({
  handshakeTimeoutMs: 15000,
  registerTimeoutMs: 10000,
  pingIntervalMs: 30000,
  livenessTimeoutMs: 40000,
  reconnectBackoffMs: [5000, 10000, 20000, 30000],
  reconnectJitterRatio: 0.2,
  livenessCheckMs: 1000,
  errorLogIntervalMs: 60000
});

function createConnectionLifecycle({ WebSocket, serverUrl, log, now = () => Date.now(), random = Math.random, timers = {}, options = {}, onConnect, onOpen, onMessage, onRegisterAck, onClose, onError, onReconnectScheduled } = {}) {
  if (!WebSocket || typeof WebSocket !== "function") throw new Error("WebSocket obrigatório.");
  const config = { ...DEFAULTS, ...options };
  const setTimeoutFn = timers.setTimeout || setTimeout;
  const clearTimeoutFn = timers.clearTimeout || clearTimeout;
  const setIntervalFn = timers.setInterval || setInterval;
  const clearIntervalFn = timers.clearInterval || clearInterval;
  const openState = WebSocket.OPEN ?? 1;
  let activeSocket = null;
  let reconnectTimer = null;
  let handshakeTimer = null;
  let registerTimer = null;
  let livenessTimer = null;
  let reconnectAttempt = 0;
  let stopping = false;
  let lastPongAt = 0;
  let lastPingAt = 0;
  let lastErrorAt = -Infinity;
  let suppressedErrors = 0;

  function clearTimer(timer, clear) {
    if (timer != null) clear(timer);
    return null;
  }

  function clearSocketTimers() {
    handshakeTimer = clearTimer(handshakeTimer, clearTimeoutFn);
    registerTimer = clearTimer(registerTimer, clearTimeoutFn);
    livenessTimer = clearTimer(livenessTimer, clearIntervalFn);
  }

  function reportError(error) {
    const timestamp = now();
    if (timestamp - lastErrorAt < config.errorLogIntervalMs) {
      suppressedErrors += 1;
      return;
    }
    const suppressed = suppressedErrors;
    suppressedErrors = 0;
    lastErrorAt = timestamp;
    onError?.(error, suppressed);
  }

  function reconnectDelay() {
    const base = config.reconnectBackoffMs[Math.min(reconnectAttempt, config.reconnectBackoffMs.length - 1)];
    reconnectAttempt += 1;
    const jitter = 1 - config.reconnectJitterRatio + (Math.max(0, Math.min(1, random())) * config.reconnectJitterRatio * 2);
    return Math.max(0, Math.round(base * jitter));
  }

  function scheduleReconnect(payload) {
    if (stopping || reconnectTimer != null) return false;
    const delay = reconnectDelay();
    onReconnectScheduled?.(delay);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect(payload);
    }, delay);
    return true;
  }

  function closeSocket(socket, reason, payload) {
    if (activeSocket !== socket) return;
    clearSocketTimers();
    activeSocket = null;
    try {
      if (typeof socket.terminate === "function") socket.terminate();
      else if (typeof socket.close === "function") socket.close();
    } catch (error) {
      reportError(error);
    }
    onClose?.(socket, reason);
    scheduleReconnect(payload);
  }

  function startLiveness(socket, payload) {
    lastPongAt = now();
    lastPingAt = 0;
    livenessTimer = setIntervalFn(() => {
      if (activeSocket !== socket) return;
      const timestamp = now();
      if (timestamp - lastPongAt > config.livenessTimeoutMs) {
        closeSocket(socket, "liveness_timeout", payload);
        return;
      }
      if (timestamp - lastPingAt >= config.pingIntervalMs) {
        lastPingAt = timestamp;
        try {
          if (typeof socket.ping === "function") socket.ping();
          else closeSocket(socket, "liveness_unsupported", payload);
        } catch (error) {
          reportError(error);
          closeSocket(socket, "liveness_error", payload);
        }
      }
    }, config.livenessCheckMs);
  }

  function attach(socket, payload) {
    let opened = false;
    let registered = false;
    handshakeTimer = setTimeoutFn(() => {
      if (activeSocket === socket && !opened) closeSocket(socket, "handshake_timeout", payload);
    }, config.handshakeTimeoutMs);

    socket.on("open", () => {
      if (activeSocket !== socket || stopping) return;
      opened = true;
      handshakeTimer = clearTimer(handshakeTimer, clearTimeoutFn);
      startLiveness(socket, payload);
      registerTimer = setTimeoutFn(() => {
        if (activeSocket === socket && !registered) closeSocket(socket, "register_timeout", payload);
      }, config.registerTimeoutMs);
      onOpen?.(socket, payload);
    });

    socket.on("message", (raw) => {
      if (activeSocket !== socket || stopping) return;
      let message = null;
      try { message = JSON.parse(raw.toString()); } catch {}
      const registrationConfirmed = ["register_ack", "remote_action_reconcile_request"].includes(message?.type)
        && message.deviceId === payload?.deviceId;
      if (registrationConfirmed) {
        registered = true;
        registerTimer = clearTimer(registerTimer, clearTimeoutFn);
        reconnectAttempt = 0;
        onRegisterAck?.(socket, message, payload);
      }
      onMessage?.(socket, raw, message);
    });

    socket.on("pong", () => {
      if (activeSocket === socket) lastPongAt = now();
    });

    socket.on("error", (error) => {
      if (activeSocket === socket) reportError(error);
    });

    socket.on("close", () => {
      if (activeSocket !== socket) return;
      clearSocketTimers();
      activeSocket = null;
      onClose?.(socket, "closed");
      scheduleReconnect(payload);
    });
  }

  function connect(payload) {
    if (stopping || activeSocket) return false;
    try {
      const socket = new WebSocket(serverUrl);
      activeSocket = socket;
      onConnect?.(socket, payload);
      attach(socket, payload);
      return true;
    } catch (error) {
      reportError(error);
      scheduleReconnect(payload);
      return false;
    }
  }

  function stop() {
    stopping = true;
    reconnectTimer = clearTimer(reconnectTimer, clearTimeoutFn);
    const socket = activeSocket;
    if (!socket) return;
    clearSocketTimers();
    activeSocket = null;
    try { if (typeof socket.close === "function") socket.close(); } catch (error) { reportError(error); }
    onClose?.(socket, "intentional_shutdown");
  }

  function resume() {
    stopping = false;
  }

  return {
    connect,
    stop,
    resume,
    getState: () => ({ active: !!activeSocket, reconnectScheduled: reconnectTimer != null, reconnectAttempt, stopping })
  };
}

module.exports = { DEFAULTS, createConnectionLifecycle };
