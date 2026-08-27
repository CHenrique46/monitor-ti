const net = require("net");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  parseJsonLine,
  validateRegister,
  validateHeartbeat,
  validateReceivedOrAck,
  validateNoticeShow,
  serializeMessage,
  buildRegisterOk,
  buildError,
  normalizeUsername
} = require("./protocol");
const {
  emptyState,
  loadNoticeState,
  saveNoticeState,
  pruneState,
  isFinalState
} = require("./persistence");
const {
  NOTIFIER_STATES,
  DELIVERY_STATES,
  isFreshHeartbeat,
  hasNoticesCapability,
  selectNotifier,
  nextNotifierState,
  nextDeliveryState
} = require("./state");

const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\MonitorTI-Notifier";
const PIPE_RETRY_MS = 2000;

function normalizePipePath(pipeName) {
  if (!pipeName) return DEFAULT_PIPE_PATH;
  const raw = String(pipeName).trim();
  if (!raw) return DEFAULT_PIPE_PATH;
  if (raw.startsWith("\\\\.\\pipe\\")) return raw;
  return "\\\\.\\pipe\\" + raw.replace(/^\\+/, "");
}

function defaultProcessInfoLookup(pid) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$pidValue = ${Number(pid)}`,
    "$p = Get-CimInstance Win32_Process -Filter (\"ProcessId=\" + $pidValue)",
    "if (-not $p) { [pscustomobject]@{ exists=$false } | ConvertTo-Json -Compress; exit 0 }",
    "$o = Invoke-CimMethod -InputObject $p -MethodName GetOwner",
    "$gp = Get-Process -Id $pidValue",
    "[pscustomobject]@{ exists=$true; sessionId=$gp.SessionId; domain=$o.Domain; user=$o.User; path=$p.ExecutablePath } | ConvertTo-Json -Compress"
  ].join("; ");

  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 1024 * 1024 }
    );
    return JSON.parse(String(out || "{}").trim() || "{}");
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

function createNoticeRuntime(opts) {
  const {
    configDir,
    getDeviceId,
    getAppDir,
    logEvent,
    version,
    getInteractiveUser,
    onCapabilityChange,
    onServerEvent,
    processInfoLookup = defaultProcessInfoLookup,
    pipeName = DEFAULT_PIPE_PATH,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS
  } = opts;

  const pipePath = normalizePipePath(pipeName);
  const state = {
    connections: new Map(),
    deliveries: new Map(),
    queue: [],
    queueSet: new Set(),
    server: null,
    started: false,
    capability: false,
    heartbeatTimer: null,
    shuttingDown: false,
    persisted: emptyState(),
    saveScheduled: false,
    shutdownRequest: null
  };

  function log(m) {
    if (typeof logEvent === "function") logEvent(m);
  }

  function getDeliverySnapshot(delivery) {
    if (!delivery) return null;
    return {
      noticeDeliveryId: delivery.noticeDeliveryId,
      state: delivery.state,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      expiresAt: delivery.expiresAt || null,
      sessionId: delivery.sessionId || null,
      displayedAt: delivery.displayedAt || null,
      acknowledgedAt: delivery.acknowledgedAt || null,
      payload: delivery.payload || null
    };
  }

  function scheduleSave() {
    if (state.saveScheduled) return;
    state.saveScheduled = true;
    setImmediate(() => {
      state.saveScheduled = false;
      try {
        const snapshot = pruneState({
          version: 1,
          deliveries: Object.fromEntries(Array.from(state.deliveries.entries()).map(([id, delivery]) => [id, getDeliverySnapshot(delivery)])),
          queue: state.queue.map((d) => d.noticeDeliveryId),
          dedup: Object.fromEntries(Array.from(state.deliveries.entries()).map(([id, delivery]) => [id, { state: delivery.state, updatedAt: delivery.updatedAt }])),
          updatedAt: new Date().toISOString()
        });
        saveNoticeState(configDir, snapshot);
      } catch (err) {
        log("falha ao salvar notices.json: " + err.message);
      }
    });
  }

  function hydratePersistedState() {
    state.persisted = loadNoticeState(configDir, log);
    state.deliveries.clear();
    state.queue = [];
    state.queueSet.clear();

    const deliveries = state.persisted.deliveries || {};
    for (const [id, delivery] of Object.entries(deliveries)) {
      if (!delivery || typeof delivery !== "object") continue;
      state.deliveries.set(id, { ...delivery });
    }

    for (const id of state.persisted.queue || []) {
      const delivery = state.deliveries.get(id);
      if (delivery) {
        state.queue.push(delivery);
        state.queueSet.add(id);
      }
    }

    for (const delivery of state.deliveries.values()) {
      if (!state.queueSet.has(delivery.noticeDeliveryId) && delivery.state === "QUEUED") {
        state.queue.push(delivery);
        state.queueSet.add(delivery.noticeDeliveryId);
      }
    }
    scheduleSave();
  }

  function updatePersistedDelivery(delivery) {
    if (!delivery || !delivery.noticeDeliveryId) return;
    state.deliveries.set(delivery.noticeDeliveryId, { ...delivery });
    scheduleSave();
  }

  function emitCapability() {
    const now = Date.now();
    const eligible = hasNoticesCapability(state.connections.values(), now, heartbeatTimeoutMs);
    if (eligible === state.capability) return;
    state.capability = eligible;
    if (typeof onCapabilityChange === "function") {
      onCapabilityChange(eligible ? ["notices"] : []);
    }
  }

  function sessionEligible(connection) {
    const user = typeof getInteractiveUser === "function" ? normalizeUsername(getInteractiveUser() || "") : "";
    if (!user) return true;
    return normalizeUsername(connection.username).toLowerCase() === user.toLowerCase();
  }

  function connectionKey(sessionId, pid) {
    return String(sessionId) + ":" + String(pid);
  }

  function getActiveConnection() {
    return selectNotifier(state.connections.values(), Date.now(), heartbeatTimeoutMs);
  }

  function send(conn, obj) {
    if (!conn || !conn.socket || conn.socket.destroyed) return false;
    try {
      conn.socket.write(serializeMessage(obj));
      return true;
    } catch (e) {
      log("pipe write falhou: " + e.message);
      return false;
    }
  }

  function sendError(conn, code, message) {
    try {
      send(conn, buildError(code, message));
    } catch {}
  }

  function setConnectionState(conn, next, reason) {
    if (!conn || conn.state === next) return;
    conn.state = next;
    conn.updatedAt = Date.now();
    if (reason) log("notifier_state " + conn.sessionId + ":" + conn.pid + " -> " + next + " (" + reason + ")");
    emitCapability();
  }

  function routeNext() {
    const conn = getActiveConnection();
    if (!conn || conn.state !== NOTIFIER_STATES.READY) return;
    if (state.queue.length >= 100) {
      log("QUEUE_FULL");
      return;
    }
    const next = state.queue.shift();
    if (!next) return;
    state.queueSet.delete(next.noticeDeliveryId);

    const delivery = state.deliveries.get(next.noticeDeliveryId) || next;
    delivery.state = DELIVERY_STATES.ROUTED;
    delivery.sessionId = conn.sessionId;
    delivery.pid = conn.pid;
    delivery.routedAt = Date.now();
    delivery.updatedAt = Date.now();
    state.deliveries.set(delivery.noticeDeliveryId, delivery);

    const ok = send(conn, {
      type: "notice_show",
      protocolVersion: PROTOCOL_VERSION,
      noticeDeliveryId: delivery.noticeDeliveryId,
      title: delivery.title,
      message: delivery.message,
      level: delivery.level,
      url: delivery.url || null,
      timestamp: delivery.timestamp,
      expiresAt: delivery.expiresAt || null
    });

    if (!ok) {
      delivery.state = DELIVERY_STATES.QUEUED;
      delivery.updatedAt = Date.now();
      state.queue.unshift(next);
      state.queueSet.add(next.noticeDeliveryId);
      updatePersistedDelivery(delivery);
      return;
    }

    delivery.state = DELIVERY_STATES.SENT_TO_NOTIFIER;
    delivery.sentAt = Date.now();
    delivery.updatedAt = Date.now();
    conn.activeNoticeDeliveryId = delivery.noticeDeliveryId;
    setConnectionState(conn, NOTIFIER_STATES.BUSY, "notice routed");
    log("notice_routed " + delivery.noticeDeliveryId + " session=" + conn.sessionId);
    updatePersistedDelivery(delivery);
  }

  function rejectBusyDelivery(deliveryId, reason) {
    const conn = getActiveConnection();
    if (conn && conn.state === NOTIFIER_STATES.BUSY) {
      sendError(conn, "INVALID_STATE", reason || "Aviso em exibição");
      return true;
    }
    return false;
  }

  function enqueueNotice(notice) {
    const d = validateNoticeShow({ type: "notice_show", protocolVersion: PROTOCOL_VERSION, ...notice });
    if (!d.ok) {
      log("notice_show rejeitado: " + d.code + " " + d.message);
      return false;
    }

    const n = d.value;
    const existing = state.deliveries.get(n.noticeDeliveryId);
    if (existing && (existing.state === DELIVERY_STATES.ACKNOWLEDGED || existing.state === DELIVERY_STATES.DISPLAYED)) {
      return true;
    }
    if (state.queueSet.has(n.noticeDeliveryId)) return true;
    if (state.queue.length >= 100) {
      log("QUEUE_FULL " + n.noticeDeliveryId);
      return false;
    }

    if (rejectBusyDelivery(n.noticeDeliveryId, "Aviso já em exibição")) {
      log("notice_rejeitado_busy " + n.noticeDeliveryId);
      return false;
    }

    const active = getActiveConnection();
    const delivery = {
      ...n,
      payload: {
        noticeDeliveryId: n.noticeDeliveryId,
        title: n.title,
        message: n.message,
        level: n.level,
        timestamp: n.timestamp,
        scheduledAt: n.scheduledAt || null,
        expiresAt: n.expiresAt || null,
        url: n.url || null
      },
      state: DELIVERY_STATES.QUEUED,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    state.deliveries.set(n.noticeDeliveryId, delivery);

    if (active && active.state === NOTIFIER_STATES.READY) {
      state.queue.push(delivery);
      state.queueSet.add(n.noticeDeliveryId);
      log("notice_queued " + n.noticeDeliveryId);
      routeNext();
      scheduleSave();
      return true;
    }

    state.queue.push(delivery);
    state.queueSet.add(n.noticeDeliveryId);
    log("notice_queued " + n.noticeDeliveryId);
    scheduleSave();
    return true;
  }

  function acceptNoticeReceived(conn, msg) {
    const payload = validateReceivedOrAck(msg, "received");
    if (!payload.ok) {
      sendError(conn, payload.code, payload.message);
      return;
    }

    const delivery = state.deliveries.get(payload.value.noticeDeliveryId);
    if (!delivery) {
      sendError(conn, "UNKNOWN_NOTICE", "Aviso desconhecido");
      return;
    }
    if (delivery.state !== DELIVERY_STATES.SENT_TO_NOTIFIER && delivery.state !== DELIVERY_STATES.DISPLAYED) {
      sendError(conn, "INVALID_STATE", "Aviso fora de estado");
      return;
    }

    delivery.state = DELIVERY_STATES.DISPLAYED;
    delivery.displayedAt = delivery.displayedAt || Date.now();
    delivery.updatedAt = Date.now();
    conn.activeNoticeDeliveryId = delivery.noticeDeliveryId;
    setConnectionState(conn, NOTIFIER_STATES.BUSY, "received");
    log("received " + delivery.noticeDeliveryId);
    updatePersistedDelivery(delivery);

    if (typeof onServerEvent === "function") {
      onServerEvent({ type: "notice_received", deviceId: getDeviceId(), noticeDeliveryId: delivery.noticeDeliveryId });
    }
  }

  function acceptAcknowledged(conn, msg) {
    const payload = validateReceivedOrAck(msg, "acknowledged");
    if (!payload.ok) {
      sendError(conn, payload.code, payload.message);
      return;
    }

    const delivery = state.deliveries.get(payload.value.noticeDeliveryId);
    if (!delivery) {
      sendError(conn, "UNKNOWN_NOTICE", "Aviso desconhecido");
      return;
    }
    if (delivery.state !== DELIVERY_STATES.DISPLAYED) {
      sendError(conn, "INVALID_STATE", "Aviso não exibido");
      return;
    }

    delivery.state = DELIVERY_STATES.ACKNOWLEDGED;
    delivery.acknowledgedAt = Date.now();
    delivery.updatedAt = Date.now();
    conn.activeNoticeDeliveryId = null;
    setConnectionState(conn, NOTIFIER_STATES.READY, "acknowledged");
    log("acknowledged " + delivery.noticeDeliveryId);
    updatePersistedDelivery(delivery);

    if (typeof onServerEvent === "function") {
      onServerEvent({ type: "notice_acknowledged", deviceId: getDeviceId(), noticeDeliveryId: delivery.noticeDeliveryId });
    }

    routeNext();
  }

  function handleRegister(conn, msg) {
    const reg = validateRegister(msg);
    if (!reg.ok) {
      sendError(conn, reg.code, reg.message);
      conn.socket.destroy();
      return;
    }

    const info = processInfoLookup(reg.value.pid);
    if (!info || !info.exists) {
      sendError(conn, "UNAUTHORIZED_CLIENT", "Processo do cliente nao encontrado");
      conn.socket.destroy();
      return;
    }
    if (Number(info.sessionId) !== Number(reg.value.sessionId)) {
      sendError(conn, "UNAUTHORIZED_CLIENT", "SessionId divergente");
      conn.socket.destroy();
      return;
    }

    const regUser = String(reg.value.username || "").toLowerCase();
    const realUser = String((info.domain ? info.domain + "\\" : "") + (info.user || "")).toLowerCase();
    const realUserShort = String(info.user || "").toLowerCase();
    if (regUser !== realUser && regUser !== realUserShort) {
      sendError(conn, "UNAUTHORIZED_CLIENT", "Usuario divergente");
      conn.socket.destroy();
      return;
    }

    conn.sessionId = reg.value.sessionId;
    conn.pid = reg.value.pid;
    conn.username = reg.value.username;
    conn.notifierVersion = reg.value.notifierVersion;
    conn.activeNoticeDeliveryId = reg.value.activeNoticeDeliveryId || null;
    conn.registeredAt = Date.now();
    conn.lastHeartbeat = Date.now();
    conn.sessionEligible = sessionEligible(conn);

    state.connections.set(connectionKey(conn.sessionId, conn.pid), conn);

    if (!conn.sessionEligible) {
      sendError(conn, "UNAUTHORIZED_CLIENT", "Sessão não elegível");
      conn.socket.destroy();
      return;
    }

    setConnectionState(conn, NOTIFIER_STATES.REGISTERED, "register valid");
    log("register_valid session=" + conn.sessionId + " pid=" + conn.pid + " user=" + conn.username);
    send(conn, buildRegisterOk(version, conn.sessionId, false));
    reconcileConnection(conn, reg.value.activeNoticeDeliveryId);
    emitCapability();
    routeNext();
  }

  function reconcileConnection(conn, activeNoticeDeliveryId) {
    const activeId = activeNoticeDeliveryId || null;
    const persisted = activeId ? state.deliveries.get(activeId) : null;
    if (!persisted) {
      for (const delivery of state.deliveries.values()) {
        if (delivery.state === DELIVERY_STATES.SENT_TO_NOTIFIER && !delivery.receivedAt) {
          delivery.state = DELIVERY_STATES.QUEUED;
          delivery.updatedAt = Date.now();
          if (!state.queueSet.has(delivery.noticeDeliveryId)) {
            state.queue.push(delivery);
            state.queueSet.add(delivery.noticeDeliveryId);
          }
          log("reconcile_retry " + delivery.noticeDeliveryId);
          updatePersistedDelivery(delivery);
        }
      }
      return;
    }
    if (persisted.state === DELIVERY_STATES.DISPLAYED) {
      conn.activeNoticeDeliveryId = persisted.noticeDeliveryId;
      setConnectionState(conn, NOTIFIER_STATES.BUSY, "reconcile displayed");
      log("reconcile_busy " + persisted.noticeDeliveryId);
      return;
    }
    if (persisted.state === DELIVERY_STATES.ACKNOWLEDGED) {
      conn.activeNoticeDeliveryId = null;
      setConnectionState(conn, NOTIFIER_STATES.READY, "reconcile acknowledged");
      log("reconcile_acknowledged " + persisted.noticeDeliveryId);
      return;
    }
    if (persisted.state === DELIVERY_STATES.SENT_TO_NOTIFIER) {
      persisted.state = DELIVERY_STATES.QUEUED;
      persisted.updatedAt = Date.now();
      if (!state.queueSet.has(persisted.noticeDeliveryId)) {
        state.queue.push(persisted);
        state.queueSet.add(persisted.noticeDeliveryId);
      }
      log("reconcile_queued " + persisted.noticeDeliveryId);
      updatePersistedDelivery(persisted);
    }
  }

  function handleHeartbeat(conn, msg) {
    const hb = validateHeartbeat(msg);
    if (!hb.ok) {
      sendError(conn, hb.code, hb.message);
      conn.socket.destroy();
      return;
    }
    if (conn.sessionId !== hb.value.sessionId || conn.pid !== hb.value.pid) {
      sendError(conn, "INVALID_STATE", "Heartbeat divergente");
      return;
    }

    conn.lastHeartbeat = Date.now();
    conn.updatedAt = Date.now();
    if (conn.state === NOTIFIER_STATES.REGISTERED || conn.state === NOTIFIER_STATES.STALE) {
      setConnectionState(conn, NOTIFIER_STATES.READY, "heartbeat");
      routeNext();
    } else if (conn.state === NOTIFIER_STATES.BUSY) {
      setConnectionState(conn, NOTIFIER_STATES.BUSY, "heartbeat");
    }
    log("heartbeat " + conn.sessionId + ":" + conn.pid);
  }

  function handleIncoming(conn, line) {
    if (Buffer.byteLength(line, "utf8") > MAX_MESSAGE_BYTES) {
      sendError(conn, "MESSAGE_TOO_LARGE", "Mensagem muito grande");
      conn.socket.destroy();
      return;
    }

    const msg = parseJsonLine(line);
    if (!msg) {
      sendError(conn, "INVALID_PAYLOAD", "JSON inválido");
      conn.socket.destroy();
      return;
    }

    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      sendError(conn, "PROTOCOL_MISMATCH", "Versão incompatível");
      conn.socket.destroy();
      return;
    }

    switch (msg.type) {
      case "register":
        handleRegister(conn, msg);
        break;
      case "heartbeat":
        handleHeartbeat(conn, msg);
        break;
      case "received":
        acceptNoticeReceived(conn, msg);
        break;
      case "acknowledged":
        acceptAcknowledged(conn, msg);
        break;
      case "shutdown_ack":
        setConnectionState(conn, NOTIFIER_STATES.CLOSING, "shutdown_ack");
        if (state.shutdownRequest) {
          try { clearTimeout(state.shutdownRequest.timer); } catch {}
          state.shutdownRequest.resolve(true);
          state.shutdownRequest = null;
        }
        try { conn.socket.end(); } catch {}
        break;
      case "error":
        log("notifier_error " + (msg.code || "unknown"));
        break;
      default:
        sendError(conn, "INVALID_PAYLOAD", "Tipo desconhecido");
        break;
    }
  }

  function removeConnection(conn) {
    if (!conn) return;
    state.connections.delete(connectionKey(conn.sessionId, conn.pid));
    if (conn.state !== NOTIFIER_STATES.CLOSING) {
      setConnectionState(conn, NOTIFIER_STATES.DISCONNECTED, "disconnect");
    }
    emitCapability();
    log("disconnect " + (conn.sessionId == null ? "?" : conn.sessionId) + ":" + (conn.pid == null ? "?" : conn.pid));
    if (state.shutdownRequest) {
      try { clearTimeout(state.shutdownRequest.timer); } catch {}
      state.shutdownRequest.resolve(false);
      state.shutdownRequest = null;
    }
  }

  function heartbeatSweep() {
    const now = Date.now();
    for (const conn of state.connections.values()) {
      if (!isFreshHeartbeat(conn.lastHeartbeat, now, heartbeatTimeoutMs) && conn.state !== NOTIFIER_STATES.DISCONNECTED) {
        setConnectionState(conn, NOTIFIER_STATES.STALE, "heartbeat timeout");
        log("stale " + conn.sessionId + ":" + conn.pid);
        try { conn.socket.end(); } catch {}
      }
    }
    emitCapability();
  }

  function start() {
    if (state.started) return;
    state.started = true;
    hydratePersistedState();
    fs.mkdirSync(path.join(configDir, "state"), { recursive: true });
    state.server = net.createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) => {
      const conn = {
        socket,
        state: NOTIFIER_STATES.CONNECTING,
        sessionId: null,
        pid: null,
        username: null,
        notifierVersion: null,
        activeNoticeDeliveryId: null,
        lastHeartbeat: 0,
        registeredAt: null,
        sessionEligible: false,
        buffer: ""
      };

      log("notifier_connected");
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        conn.buffer += chunk;
        while (true) {
          const idx = conn.buffer.indexOf("\n");
          if (idx < 0) break;
          const line = conn.buffer.slice(0, idx).replace(/\r$/, "");
          conn.buffer = conn.buffer.slice(idx + 1);
          handleIncoming(conn, line);
        }
      });
      socket.on("close", () => removeConnection(conn));
      socket.on("error", (err) => {
        log("pipe_error " + err.message);
        removeConnection(conn);
      });
    });

    state.server.on("error", (err) => log("pipe_server_error " + err.message));
    state.server.listen(pipePath, { readableAll: true, writableAll: true });
    state.heartbeatTimer = setInterval(heartbeatSweep, heartbeatIntervalMs);
    if (state.heartbeatTimer && typeof state.heartbeatTimer.unref === "function") state.heartbeatTimer.unref();
    log("pipe_server_listening " + pipePath);
  }

  function stop() {
    state.shuttingDown = true;
    for (const conn of state.connections.values()) {
      setConnectionState(conn, NOTIFIER_STATES.CLOSING, "agent stop");
      try { conn.socket.destroy(); } catch {}
    }
    state.connections.clear();
    state.queue = [];
    state.queueSet.clear();
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.server) {
      try { state.server.close(); } catch {}
    }
    state.started = false;
  }

  function requestShutdown(reason = "update", timeoutMs = 10000) {
    const conn = getActiveConnection();
    if (!conn || !conn.socket) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (state.shutdownRequest && state.shutdownRequest.resolve === resolve) {
          state.shutdownRequest = null;
        }
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      state.shutdownRequest = { resolve, timer };
      try {
        send(conn, { type: "shutdown", protocolVersion: PROTOCOL_VERSION, reason });
      } catch {
        clearTimeout(timer);
        state.shutdownRequest = null;
        resolve(false);
      }
    });
  }

  function getConnectionSnapshot() {
    return Array.from(state.connections.values()).map((c) => ({
      sessionId: c.sessionId,
      username: c.username,
      pid: c.pid,
      notifierVersion: c.notifierVersion,
      lastHeartbeat: c.lastHeartbeat,
      registeredAt: c.registeredAt,
      state: c.state,
      activeNoticeDeliveryId: c.activeNoticeDeliveryId
    }));
  }

  function getDeliveriesSnapshot() {
    return Array.from(state.deliveries.values());
  }

  function isNotifierReady() {
    return hasNoticesCapability(state.connections.values(), Date.now(), heartbeatTimeoutMs);
  }

  function getState() {
    return {
      pipePath,
      connections: getConnectionSnapshot(),
      queueLength: state.queue.length,
      capability: state.capability,
      started: state.started
    };
  }

  return {
    start,
    stop,
    requestShutdown,
    enqueueFromServer: enqueueNotice,
    isNotifierReady,
    getConnectionSnapshot,
    getDeliveriesSnapshot,
    hasNoticesCapability: () => isNotifierReady(),
    getState,
    pipePath
  };
}

module.exports = { createNoticeRuntime, DEFAULT_PIPE_PATH, normalizePipePath };
