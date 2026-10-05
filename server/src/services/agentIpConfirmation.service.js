const { normalizeIp } = require("../networkIp");

const IP_CONFIRMATION_TTL_MS = 30 * 1000;

function createAgentIpConfirmationService({ now = () => Date.now() } = {}) {
  const confirmations = new Map();

  function confirm(deviceId, connectionId, ip) {
    const normalized = normalizeIp(ip);
    if (!deviceId || !connectionId || !normalized) {
      clear(deviceId, connectionId);
      return false;
    }
    confirmations.set(String(deviceId), { connectionId: String(connectionId), ip: normalized, expiresAt: now() + IP_CONFIRMATION_TTL_MS });
    return true;
  }

  function clear(deviceId, connectionId) {
    const key = String(deviceId || "");
    const current = confirmations.get(key);
    if (current && (!connectionId || current.connectionId === String(connectionId))) confirmations.delete(key);
  }

  function isConfirmed(deviceId, ip) {
    const current = confirmations.get(String(deviceId || ""));
    if (!current) return false;
    if (current.expiresAt <= now()) { confirmations.delete(String(deviceId || "")); return false; }
    return current.ip === normalizeIp(ip);
  }

  function reset() { confirmations.clear(); }

  return { confirm, clear, isConfirmed, reset, _confirmations: confirmations };
}

const agentIpConfirmation = createAgentIpConfirmationService();

module.exports = { IP_CONFIRMATION_TTL_MS, createAgentIpConfirmationService, agentIpConfirmation };
