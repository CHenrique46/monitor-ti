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

module.exports = { getAgentServerPublicUrl };
