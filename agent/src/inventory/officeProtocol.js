const crypto = require("crypto");
const { collectOfficeInventory, containsFullProductKey } = require("./office");

const MAX_INSTALLATIONS = 20;
const MAX_WARNINGS = 50;
const MAX_STRING_LENGTH = 512;
const INSTALLATION_FIELDS = [
  "source",
  "productReleaseId",
  "productName",
  "edition",
  "version",
  "architecture",
  "updateChannel",
  "installationTechnology",
  "activationStatus",
  "rawStatusCode",
  "licenseType",
  "licenseName",
  "licenseDescription",
  "partialProductKey",
  "fingerprint"
];

function boundedString(value) {
  if (value == null) return null;
  const result = String(value).trim();
  if (!result || result.length > MAX_STRING_LENGTH || containsFullProductKey(result)) return null;
  return result;
}

function sanitizeInstallation(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const result = {};
  for (const field of INSTALLATION_FIELDS) result[field] = boundedString(item[field]);
  if (result.partialProductKey && !/^[A-Za-z0-9]{5}$/.test(result.partialProductKey)) result.partialProductKey = null;
  return result;
}

function sanitizeOfficeInventory(inventory = {}) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return null;
  const installations = Array.isArray(inventory.installations)
    ? inventory.installations.slice(0, MAX_INSTALLATIONS).map(sanitizeInstallation).filter(Boolean)
    : [];
  const warnings = Array.isArray(inventory.warnings)
    ? inventory.warnings.slice(0, MAX_WARNINGS).map(boundedString).filter(Boolean)
    : [];
  const collectedAt = boundedString(inventory.collectedAt);
  const result = { collectedAt, installations, warnings };
  if (containsFullProductKey(JSON.stringify(result))) return null;
  return result;
}

function buildInventoryMessage(deviceId, inventory) {
  const safeDeviceId = boundedString(deviceId);
  const office = sanitizeOfficeInventory(inventory);
  if (!safeDeviceId || !office) return null;
  return { type: "inventory", deviceId: safeDeviceId, data: { office } };
}

function inventoryFingerprint(office) {
  const stable = {
    installations: office.installations.map((item) => item.fingerprint || item).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    warnings: office.warnings
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function createOfficeInventorySender({ collector = collectOfficeInventory, logEvent = () => {} } = {}) {
  let lastFingerprint = null;

  async function send(ws, deviceId) {
    try {
      const inventory = await collector();
      const message = buildInventoryMessage(deviceId, inventory);
      if (!message) return { sent: false, reason: "invalid_inventory" };
      const fingerprint = inventoryFingerprint(message.data.office);
      if (fingerprint === lastFingerprint) return { sent: false, reason: "unchanged" };
      if (!ws || ws.readyState !== ws.OPEN) return { sent: false, reason: "socket_unavailable" };
      ws.send(JSON.stringify(message));
      lastFingerprint = fingerprint;
      return { sent: true, installations: message.data.office.installations.length };
    } catch (error) {
      try { logEvent("Office inventory unavailable: " + (error && error.message ? error.message : "collector error").slice(0, 160)); } catch {}
      return { sent: false, reason: "collector_failed" };
    }
  }

  return { send, reset: () => { lastFingerprint = null; } };
}

function scheduleOfficeInventory(task, delayMs = 1000) {
  const timer = setTimeout(() => Promise.resolve().then(task).catch(() => {}), delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  MAX_INSTALLATIONS,
  MAX_WARNINGS,
  MAX_STRING_LENGTH,
  sanitizeOfficeInventory,
  buildInventoryMessage,
  inventoryFingerprint,
  createOfficeInventorySender,
  scheduleOfficeInventory
};
