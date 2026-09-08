const NATIVE_CAPABILITIES = Object.freeze(["disk_cleanup_analyze"]);

function compareVersion(a, b) {
  const pa = String(a || "0").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function getNativeCapabilities(version) {
  return compareVersion(version, "1.1.20") >= 0 ? [...NATIVE_CAPABILITIES] : [];
}

function composeCapabilities({ version, notifier } = {}) {
  const dynamic = notifier && typeof notifier.isNotifierReady === "function" && notifier.isNotifierReady()
    ? ["notices"]
    : [];
  return [...new Set([...getNativeCapabilities(version), ...dynamic])];
}

function getCurrentCapabilities(notifier) {
  return Promise.resolve(composeCapabilities({ notifier }));
}

async function sendCurrentCapabilities(ws, deviceId, notifier, logEvent) {
  try {
    if (!ws || typeof ws.send !== "function" || ws.readyState !== 1) return false;

    const capabilities = await getCurrentCapabilities(notifier);
    const payload = {
      type: "capabilities",
      deviceId,
      data: { capabilities }
    };

    ws.send(JSON.stringify(payload));
    if (typeof logEvent === "function") {
      logEvent("Capabilities enviadas: " + (capabilities.length ? capabilities.join(",") : "nenhuma"));
    }
    return true;
  } catch (err) {
    if (typeof logEvent === "function") {
      logEvent("Erro ao enviar capabilities: " + err.message);
    }
    return false;
  }
}

module.exports = { NATIVE_CAPABILITIES, getNativeCapabilities, composeCapabilities, getCurrentCapabilities, sendCurrentCapabilities };
