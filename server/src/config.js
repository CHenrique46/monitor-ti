const path = require("path");

function getInventoryExcelPath() {
  return String(process.env.INVENTORY_EXCEL_PATH || path.join(__dirname, "..", "..", "private", "inventory", "inventario.xlsx")).trim();
}

function getCertificadosClientesPath() {
  return String(process.env.CERTIFICADOS_CLIENTES_PATH || "").trim();
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

module.exports = { getAgentServerPublicUrl, getInventoryExcelPath, getCertificadosClientesPath };
