function getCurrentCapabilities(notifier) {
  if (notifier && typeof notifier.isNotifierReady === "function" && notifier.isNotifierReady()) {
    return ["notices"];
  }
  return [];
}

function sendCurrentCapabilities(ws, deviceId, notifier) {
  if (!ws || typeof ws.send !== "function") return false;
  const capabilities = getCurrentCapabilities(notifier);
  if (!capabilities.length) return false;
  ws.send(
    JSON.stringify({
      type: "capabilities",
      deviceId,
      data: { capabilities }
    })
  );
  return true;
}

module.exports = { getCurrentCapabilities, sendCurrentCapabilities };
