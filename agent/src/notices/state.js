const READY_STATES = new Set(["READY", "BUSY"]);
const ELIGIBLE_STATES = new Set(["REGISTERED", "READY", "BUSY"]);

const NOTIFIER_STATES = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  REGISTERED: "REGISTERED",
  READY: "READY",
  BUSY: "BUSY",
  STALE: "STALE",
  CLOSING: "CLOSING"
};

const DELIVERY_STATES = {
  QUEUED: "QUEUED",
  ROUTED: "ROUTED",
  SENT_TO_NOTIFIER: "SENT_TO_NOTIFIER",
  DISPLAYED: "DISPLAYED",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  EXPIRED: "EXPIRED",
  FAILED: "FAILED"
};

function isFreshHeartbeat(lastHeartbeat, now = Date.now(), timeoutMs = 45000) {
  if (!lastHeartbeat) return false;
  return now - new Date(lastHeartbeat).getTime() <= timeoutMs;
}

function isEligibleConnection(conn, now = Date.now(), timeoutMs = 45000) {
  if (!conn) return false;
  if (!ELIGIBLE_STATES.has(conn.state)) return false;
  if (!isFreshHeartbeat(conn.lastHeartbeat, now, timeoutMs)) return false;
  return !!conn.sessionEligible;
}

function hasNoticesCapability(connections, now = Date.now(), timeoutMs = 45000) {
  const values = Array.isArray(connections) ? connections : Array.from(connections || []);
  return values.some((conn) => READY_STATES.has(conn.state) && isEligibleConnection(conn, now, timeoutMs));
}

function scoreConnection(conn, now = Date.now()) {
  const stateScore = conn.state === "READY" ? 3 : conn.state === "BUSY" ? 2 : conn.state === "REGISTERED" ? 1 : 0;
  const heartbeatScore = conn.lastHeartbeat ? new Date(conn.lastHeartbeat).getTime() : 0;
  return stateScore * 1e13 + heartbeatScore;
}

function selectNotifier(connections, now = Date.now(), timeoutMs = 45000) {
  const values = Array.isArray(connections) ? connections : Array.from(connections || []);
  const eligible = values.filter((conn) => isEligibleConnection(conn, now, timeoutMs) && READY_STATES.has(conn.state));
  if (!eligible.length) return null;
  eligible.sort((a, b) => scoreConnection(b, now) - scoreConnection(a, now));
  return eligible[0];
}

function nextNotifierState(current, event) {
  switch (current) {
    case NOTIFIER_STATES.DISCONNECTED:
      if (event === "connect") return NOTIFIER_STATES.CONNECTING;
      return current;
    case NOTIFIER_STATES.CONNECTING:
      if (event === "register_ok") return NOTIFIER_STATES.REGISTERED;
      if (event === "close" || event === "error") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    case NOTIFIER_STATES.REGISTERED:
      if (event === "heartbeat") return NOTIFIER_STATES.READY;
      if (event === "stale") return NOTIFIER_STATES.STALE;
      if (event === "close") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    case NOTIFIER_STATES.READY:
      if (event === "notice_show") return NOTIFIER_STATES.BUSY;
      if (event === "stale") return NOTIFIER_STATES.STALE;
      if (event === "close") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    case NOTIFIER_STATES.BUSY:
      if (event === "acknowledged") return NOTIFIER_STATES.READY;
      if (event === "received") return NOTIFIER_STATES.BUSY;
      if (event === "stale") return NOTIFIER_STATES.STALE;
      if (event === "close") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    case NOTIFIER_STATES.STALE:
      if (event === "connect") return NOTIFIER_STATES.CONNECTING;
      if (event === "close") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    case NOTIFIER_STATES.CLOSING:
      if (event === "close") return NOTIFIER_STATES.DISCONNECTED;
      return current;
    default:
      return current;
  }
}

function nextDeliveryState(current, event) {
  switch (current) {
    case DELIVERY_STATES.QUEUED:
      if (event === "route") return DELIVERY_STATES.ROUTED;
      if (event === "expire") return DELIVERY_STATES.EXPIRED;
      if (event === "fail") return DELIVERY_STATES.FAILED;
      return current;
    case DELIVERY_STATES.ROUTED:
      if (event === "send_success") return DELIVERY_STATES.SENT_TO_NOTIFIER;
      if (event === "send_fail") return DELIVERY_STATES.QUEUED;
      if (event === "expire") return DELIVERY_STATES.EXPIRED;
      return current;
    case DELIVERY_STATES.SENT_TO_NOTIFIER:
      if (event === "received") return DELIVERY_STATES.DISPLAYED;
      if (event === "expire") return DELIVERY_STATES.EXPIRED;
      if (event === "fail") return DELIVERY_STATES.FAILED;
      return current;
    case DELIVERY_STATES.DISPLAYED:
      if (event === "acknowledged") return DELIVERY_STATES.ACKNOWLEDGED;
      if (event === "expire") return DELIVERY_STATES.DISPLAYED;
      return current;
    case DELIVERY_STATES.ACKNOWLEDGED:
      return DELIVERY_STATES.ACKNOWLEDGED;
    case DELIVERY_STATES.EXPIRED:
      return DELIVERY_STATES.EXPIRED;
    case DELIVERY_STATES.FAILED:
      return DELIVERY_STATES.FAILED;
    default:
      return current;
  }
}

module.exports = {
  NOTIFIER_STATES,
  DELIVERY_STATES,
  isFreshHeartbeat,
  isEligibleConnection,
  hasNoticesCapability,
  selectNotifier,
  nextNotifierState,
  nextDeliveryState
};
