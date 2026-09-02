const MAX_INSTALLATIONS = 20;
const MAX_WARNINGS = 50;
const MAX_STRING_LENGTH = 512;
const FULL_PRODUCT_KEY_RE = /\b[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}\b/;
const FIELDS = [
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

function validString(value, max = MAX_STRING_LENGTH) {
  return value == null || (typeof value === "string" && value.length <= max && !FULL_PRODUCT_KEY_RE.test(value));
}

function validateInstallation(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  if (Object.keys(item).some((key) => !FIELDS.includes(key))) return false;
  if (FIELDS.some((field) => !validString(item[field]))) return false;
  return item.partialProductKey == null || /^[A-Za-z0-9]{5}$/.test(item.partialProductKey);
}

function validateInventoryMessage(message, registeredDeviceId) {
  if (!message || message.type !== "inventory" || typeof message.deviceId !== "string" || message.deviceId.length > MAX_STRING_LENGTH) {
    return { ok: false, reason: "invalid_inventory" };
  }
  if (registeredDeviceId && message.deviceId !== registeredDeviceId) return { ok: false, reason: "device_mismatch" };
  const office = message.data && message.data.office;
  if (!office || typeof office !== "object" || Array.isArray(office)) return { ok: false, reason: "invalid_office" };
  if (FULL_PRODUCT_KEY_RE.test(JSON.stringify(message))) return { ok: false, reason: "sensitive_key" };
  if (!Array.isArray(office.installations) || office.installations.length > MAX_INSTALLATIONS) return { ok: false, reason: "installations_limit" };
  if (!Array.isArray(office.warnings) || office.warnings.length > MAX_WARNINGS) return { ok: false, reason: "warnings_limit" };
  if (!validString(office.collectedAt)) return { ok: false, reason: "invalid_collected_at" };
  if (office.warnings.some((warning) => !validString(warning))) return { ok: false, reason: "invalid_warning" };
  if (office.installations.some((item) => !validateInstallation(item))) return { ok: false, reason: "invalid_installation" };
  return { ok: true, installationCount: office.installations.length };
}

module.exports = { MAX_INSTALLATIONS, MAX_WARNINGS, MAX_STRING_LENGTH, validateInventoryMessage };
