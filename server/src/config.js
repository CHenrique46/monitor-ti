const path = require("path");
const fs = require("fs");

function getInventoryExcelPath() {
  return String(process.env.INVENTORY_EXCEL_PATH || path.join(__dirname, "..", "..", "private", "inventory", "inventario.xlsx")).trim();
}

function getCertificadosClientesPath() {
  return String(process.env.CERTIFICADOS_CLIENTES_PATH || "").trim();
}

function getPortalCookieSecure() {
  return String(process.env.PORTAL_COOKIE_SECURE || "").trim().toLowerCase() === "true";
}

function getCertificadosSyncEnabled() {
  return String(process.env.CERTIFICADOS_SYNC_ENABLED || "").trim().toLowerCase() === "true";
}

function getCertificadosSyncIntervalMinutes() {
  const parsed = Number.parseInt(String(process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES || "30").trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > 1440) return 30;
  return parsed;
}

function getCertificadosLiberadosPath() {
  const raw = String(process.env.CERTIFICADOS_LIBERADOS_PATH || "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    const error = new Error("Destino de certificados liberados inválido.");
    error.code = "RELEASE_DESTINATION_INVALID";
    throw error;
  }
  const resolved = path.resolve(raw);
  let stats;
  try { stats = fs.lstatSync(resolved); } catch { throw Object.assign(new Error("Destino de certificados liberados indisponível."), { code: "RELEASE_DESTINATION_UNAVAILABLE" }); }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw Object.assign(new Error("Destino de certificados liberados inválido."), { code: "RELEASE_DESTINATION_INVALID" });
  return resolved;
}

function getCertificadosLiberadosUnc() {
  const configuredPath = String(process.env.CERTIFICADOS_LIBERADOS_PATH || "").trim().replace(/\\+$/, "");
  if (/^\\\\[^\\]+\\[^\\]+$/.test(configuredPath)) return configuredPath;
  const raw = String(process.env.CERTIFICADOS_LIBERADOS_UNC || "").trim().replace(/\\+$/, "");
  if (!/^\\\\[^\\]+\\[^\\]+/.test(raw)) {
    const error = new Error("Compartilhamento de certificados liberados inválido.");
    error.code = "RELEASE_SHARE_INVALID";
    throw error;
  }
  return raw;
}

function configurationError(message, code) {
  return Object.assign(new Error(message), { code });
}

function validateSmbSecretPath(value, fsModule = fs) {
  const raw = String(value || "").trim();
  const normalized = path.win32.normalize(raw);
  const segments = raw.split(/[\\/]+/);
  if (!raw || !path.win32.isAbsolute(normalized) || /^(?:[a-z][a-z0-9+.-]*:\/\/|\\\\[?.])/i.test(raw) || /[?*]/.test(raw) || segments.includes("..") || path.win32.basename(normalized).toLowerCase() !== "certificados-smb.dpapi") {
    throw configurationError("Credencial SMB não configurada.", "SMB_SECRET_PATH_INVALID");
  }
  let stats;
  try { stats = fsModule.lstatSync(normalized); } catch { throw configurationError("Credencial SMB indisponível.", "SMB_SECRET_FILE_UNAVAILABLE"); }
  if (!stats.isFile() || stats.isSymbolicLink()) throw configurationError("Credencial SMB inválida.", "SMB_SECRET_FILE_INVALID");
  return normalized;
}

function getCertificadosSmbSecretPath(options = {}) {
  return validateSmbSecretPath(process.env.CERTIFICATE_SMB_CREDENTIAL_FILE, options.fsModule || fs);
}

function normalizeSmbIdentity(value) {
  return String(value || "").trim().replace(/\//g, "\\");
}

function smbIdentitiesEqual(actual, expected) {
  return normalizeSmbIdentity(actual).toLowerCase() === normalizeSmbIdentity(expected).toLowerCase();
}

function getCertificadosSmbExpectedIdentity() {
  const identity = normalizeSmbIdentity(process.env.CERTIFICATE_SMB_EXPECTED_SERVICE_IDENTITY);
  if (!identity || !/^[^\\/:*?"<>|\s]+\\[^\\/:*?"<>|\s]+$/.test(identity)) {
    throw configurationError("Identidade SMB não configurada.", "SMB_IDENTITY_INVALID");
  }
  return identity;
}

function getAgentServerPublicUrl() {
  const raw = String(process.env.AGENT_SERVER_PUBLIC_URL || "").trim();
  if (!raw) {
    const error = new Error("AGENT_SERVER_PUBLIC_URL não configurada.");
    error.code = "AGENT_SERVER_PUBLIC_URL_INVALID";
    throw error;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    const error = new Error("AGENT_SERVER_PUBLIC_URL inválida.");
    error.code = "AGENT_SERVER_PUBLIC_URL_INVALID";
    throw error;
  }

  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    const error = new Error("AGENT_SERVER_PUBLIC_URL inválida.");
    error.code = "AGENT_SERVER_PUBLIC_URL_INVALID";
    throw error;
  }

  return raw.replace(/\/+$/, "");
}

module.exports = { getAgentServerPublicUrl, getInventoryExcelPath, getCertificadosClientesPath, getPortalCookieSecure, getCertificadosSyncEnabled, getCertificadosSyncIntervalMinutes, getCertificadosLiberadosPath, getCertificadosLiberadosUnc, validateSmbSecretPath, getCertificadosSmbSecretPath, normalizeSmbIdentity, smbIdentitiesEqual, getCertificadosSmbExpectedIdentity };
