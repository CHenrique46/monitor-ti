const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const USERNAME_MAX = 256;
const TITLE_MAX = 100;
const MESSAGE_MAX = 2000;
const URL_MAX = 2048;
const MAX_MESSAGE_BYTES = 65536;
const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 45000;

function isUuid(v) {
  return typeof v === "string" && UUID_RE.test(v);
}

function isVersion(v) {
  return typeof v === "string" && VERSION_RE.test(v);
}

function normalizeUsername(v) {
  return typeof v === "string" ? v.trim() : "";
}

function trimLine(v) {
  if (typeof v !== "string") return "";
  return v.replace(/\r?\n$/, "").replace(/\r$/, "");
}

function parseJsonLine(line) {
  const raw = trimLine(line);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validateRegister(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD", message: "Payload inválido" };
  if (msg.type !== "register") return { ok: false, code: "INVALID_PAYLOAD", message: "Tipo inválido" };
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "PROTOCOL_MISMATCH", message: "Versão de protocolo incompatível" };
  }
  if (!isVersion(msg.notifierVersion)) return { ok: false, code: "INVALID_PAYLOAD", message: "Versão inválida" };
  if (!Number.isInteger(msg.sessionId) || msg.sessionId < 0) return { ok: false, code: "INVALID_PAYLOAD", message: "SessionId inválido" };
  if (!Number.isInteger(msg.pid) || msg.pid <= 0) return { ok: false, code: "INVALID_PAYLOAD", message: "PID inválido" };
  const username = normalizeUsername(msg.username);
  if (!username || username.length > USERNAME_MAX) return { ok: false, code: "INVALID_PAYLOAD", message: "Usuário inválido" };
  if (!(msg.activeNoticeDeliveryId === null || isUuid(msg.activeNoticeDeliveryId))) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "activeNoticeDeliveryId inválido" };
  }
  return { ok: true, value: { ...msg, username } };
}

function validateHeartbeat(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD", message: "Payload inválido" };
  if (msg.type !== "heartbeat") return { ok: false, code: "INVALID_PAYLOAD", message: "Tipo inválido" };
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "PROTOCOL_MISMATCH", message: "Versão de protocolo incompatível" };
  }
  if (!Number.isInteger(msg.sessionId) || msg.sessionId < 0) return { ok: false, code: "INVALID_PAYLOAD", message: "SessionId inválido" };
  if (!Number.isInteger(msg.pid) || msg.pid <= 0) return { ok: false, code: "INVALID_PAYLOAD", message: "PID inválido" };
  if (typeof msg.ts !== "string" || Number.isNaN(Date.parse(msg.ts))) return { ok: false, code: "INVALID_PAYLOAD", message: "Timestamp inválido" };
  return { ok: true, value: msg };
}

function validateReceivedOrAck(msg, type) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD", message: "Payload inválido" };
  if (msg.type !== type) return { ok: false, code: "INVALID_PAYLOAD", message: "Tipo inválido" };
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "PROTOCOL_MISMATCH", message: "Versão de protocolo incompatível" };
  }
  if (!isUuid(msg.noticeDeliveryId)) return { ok: false, code: "INVALID_PAYLOAD", message: "UUID inválido" };
  if (!Number.isInteger(msg.sessionId) || msg.sessionId < 0) return { ok: false, code: "INVALID_PAYLOAD", message: "SessionId inválido" };
  if (!Number.isInteger(msg.pid) || msg.pid <= 0) return { ok: false, code: "INVALID_PAYLOAD", message: "PID inválido" };
  if (typeof msg.ts !== "string" || Number.isNaN(Date.parse(msg.ts))) return { ok: false, code: "INVALID_PAYLOAD", message: "Timestamp inválido" };
  return { ok: true, value: msg };
}

function validateNoticeShow(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD", message: "Payload inválido" };
  if (msg.type !== "notice_show") return { ok: false, code: "INVALID_PAYLOAD", message: "Tipo inválido" };
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, code: "PROTOCOL_MISMATCH", message: "Versão de protocolo incompatível" };
  }
  if (!isUuid(msg.noticeDeliveryId)) return { ok: false, code: "INVALID_PAYLOAD", message: "UUID inválido" };
  const title = typeof msg.title === "string" ? msg.title.trim() : "";
  const message = typeof msg.message === "string" ? msg.message.trim() : "";
  const url = msg.url == null ? null : (typeof msg.url === "string" ? msg.url.trim() : null);
  if (!title || title.length > TITLE_MAX) return { ok: false, code: "INVALID_PAYLOAD", message: "Título inválido" };
  if (!message || message.length > MESSAGE_MAX) return { ok: false, code: "INVALID_PAYLOAD", message: "Mensagem inválida" };
  if (typeof msg.level !== "string" || !["info", "warning", "critical"].includes(msg.level)) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Nível inválido" };
  }
  if (typeof msg.timestamp !== "string" || Number.isNaN(Date.parse(msg.timestamp))) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "Timestamp inválido" };
  }
  if (msg.expiresAt != null && (typeof msg.expiresAt !== "string" || Number.isNaN(Date.parse(msg.expiresAt)))) {
    return { ok: false, code: "INVALID_PAYLOAD", message: "expiresAt inválido" };
  }
  if (url != null && url.length > URL_MAX) return { ok: false, code: "INVALID_PAYLOAD", message: "URL inválida" };
  return { ok: true, value: { ...msg, title, message, url } };
}

function serializeMessage(obj) {
  const json = JSON.stringify(obj);
  if (Buffer.byteLength(json, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error("MESSAGE_TOO_LARGE");
  }
  return json + "\n";
}

function buildRegisterOk(agentVersion, selectedSession, noticesEnabled) {
  return {
    type: "register_ok",
    protocolVersion: PROTOCOL_VERSION,
    agentVersion,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    maxMessageBytes: MAX_MESSAGE_BYTES,
    selectedSession: selectedSession == null ? null : selectedSession,
    noticesEnabled: !!noticesEnabled
  };
}

function buildError(code, message) {
  return {
    type: "error",
    protocolVersion: PROTOCOL_VERSION,
    code,
    message
  };
}

module.exports = {
  PROTOCOL_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_MESSAGE_BYTES,
  USERNAME_MAX,
  TITLE_MAX,
  MESSAGE_MAX,
  URL_MAX,
  isUuid,
  isVersion,
  parseJsonLine,
  validateRegister,
  validateHeartbeat,
  validateReceivedOrAck,
  validateNoticeShow,
  serializeMessage,
  buildRegisterOk,
  buildError,
  normalizeUsername
};
