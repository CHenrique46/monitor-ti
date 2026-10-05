const { buildCertificateNotificationAck } = require("./certificateNotificationTest");

const PILOT_ERROR_CODES = new Set([
  "PILOT_DISABLED",
  "INVALID_EVENT",
  "TOAST_UNAVAILABLE",
  "TOAST_DISPLAY_FAILED",
  "COMPANION_UNAVAILABLE"
]);

function sendAck(ws, eventId, status, errorCode) {
  if (!ws || typeof ws.send !== "function") return;
  try {
    ws.send(JSON.stringify(buildCertificateNotificationAck(eventId, status, errorCode)));
  } catch {}
}

function safeErrorCode(value, fallback) {
  const code = String(value || "");
  return PILOT_ERROR_CODES.has(code) ? code : fallback;
}

function handleCertificateNotificationMessage({ ws, msg, noticesBridge, logEvent }) {
  const eventId = msg && typeof msg.eventId === "string" ? msg.eventId : null;
  if (typeof logEvent === "function") logEvent("PILOT_EVENT_RECEIVED");
  sendAck(ws, eventId, "RECEIVED");

  let result = { accepted: false, status: "REJECTED", reason: "PILOT_DISABLED" };
  try {
    if (noticesBridge && typeof noticesBridge.handleCertificateNotificationTestResult === "function") {
      result = noticesBridge.handleCertificateNotificationTestResult(ws, msg);
    }
  } catch {
    result = { accepted: false, status: "FAILED", reason: "BRIDGE_FAILURE" };
  }

  if (result.accepted) {
    return result;
  }

  const failed = result.status === "FAILED";
  sendAck(ws, eventId, "FAILED", safeErrorCode(result.reason, failed ? "TOAST_DISPLAY_FAILED" : "INVALID_EVENT"));
  return result;
}

module.exports = { handleCertificateNotificationMessage };
