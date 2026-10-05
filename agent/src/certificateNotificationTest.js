const crypto = require("crypto");

const CERTIFICATE_NOTIFICATION_TEST = "CERTIFICATE_NOTIFICATION_TEST";
const CERTIFICATE_NOTIFICATION_TEST_TYPE = "certificate_notification_test";
const CERTIFICATE_NOTIFICATION_TEST_ACK_TYPE = "certificate_notification_test_ack";
const ACK_STATUSES = Object.freeze(["RECEIVED", "DISPLAYED", "DUPLICATE", "FAILED"]);
const ACK_ERROR_CODES = Object.freeze([
  "PILOT_DISABLED",
  "INVALID_EVENT",
  "TOAST_UNAVAILABLE",
  "TOAST_DISPLAY_FAILED",
  "COMPANION_UNAVAILABLE"
]);
const FIXED_TITLE = "HenriTech Control";
const FIXED_MESSAGE = "Teste concluído. As notificações de certificados estão funcionando nesta máquina.";

function isPilotEnabled(value = process.env.MTI_CERTIFICATE_NOTIFICATION_TEST) {
  return String(value || "").trim() === "1";
}

function validateCertificateNotificationTest(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD" };
  const keys = Object.keys(msg).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["eventId", "eventType", "protocolVersion", "type"])) {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  if (msg.type !== CERTIFICATE_NOTIFICATION_TEST_TYPE || msg.protocolVersion !== 1) {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  if (typeof msg.eventId !== "string" || !crypto.randomUUID || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(msg.eventId)) {
    return { ok: false, code: "INVALID_EVENT_ID" };
  }
  if (msg.eventType !== CERTIFICATE_NOTIFICATION_TEST) {
    return { ok: false, code: "EVENT_NOT_ALLOWED" };
  }
  return { ok: true, value: { eventId: msg.eventId, eventType: msg.eventType } };
}

function buildCertificateNotificationAck(eventId, status, errorCode) {
  const ack = {
    type: CERTIFICATE_NOTIFICATION_TEST_ACK_TYPE,
    eventId: typeof eventId === "string" ? eventId : null,
    status: ACK_STATUSES.includes(status) ? status : "FAILED"
  };
  if (errorCode && ACK_ERROR_CODES.includes(errorCode)) ack.errorCode = errorCode;
  return ack;
}

function validateCertificateNotificationAck(msg) {
  if (!msg || typeof msg !== "object") return { ok: false, code: "INVALID_PAYLOAD" };
  const allowed = ["eventId", "status", "type", "errorCode"];
  if (Object.keys(msg).some((key) => !allowed.includes(key))) return { ok: false, code: "INVALID_PAYLOAD" };
  if (msg.type !== CERTIFICATE_NOTIFICATION_TEST_ACK_TYPE) return { ok: false, code: "INVALID_PAYLOAD" };
  if (!(msg.eventId === null || (typeof msg.eventId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(msg.eventId)))) return { ok: false, code: "INVALID_EVENT_ID" };
  if (!ACK_STATUSES.includes(msg.status)) return { ok: false, code: "INVALID_STATUS" };
  if (msg.errorCode != null && !ACK_ERROR_CODES.includes(msg.errorCode)) return { ok: false, code: "INVALID_ERROR_CODE" };
  return { ok: true, value: msg };
}

module.exports = {
  CERTIFICATE_NOTIFICATION_TEST,
  CERTIFICATE_NOTIFICATION_TEST_TYPE,
  CERTIFICATE_NOTIFICATION_TEST_ACK_TYPE,
  ACK_STATUSES,
  ACK_ERROR_CODES,
  FIXED_TITLE,
  FIXED_MESSAGE,
  isPilotEnabled,
  validateCertificateNotificationTest,
  buildCertificateNotificationAck,
  validateCertificateNotificationAck
};
