function getCurrentCapabilities(notifier) {
  if (notifier && typeof notifier.isNotifierReady === "function") {
    return Promise.resolve(notifier.isNotifierReady()).then((ready) => (ready ? ["notices"] : []));
  }
  return Promise.resolve([]);
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

module.exports = { getCurrentCapabilities, sendCurrentCapabilities };
