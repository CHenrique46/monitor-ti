const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const WEBSOCKET_SHUTDOWN_TIMEOUT_MS = 2_000;
const HTTP_SHUTDOWN_TIMEOUT_MS = 2_000;
const PRISMA_SHUTDOWN_TIMEOUT_MS = 2_000;
const WEBSOCKET_CLOSE_CODE = 1001;
const WEBSOCKET_CLOSE_REASON = "Server encerrando";

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve(false);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise).then(() => true), timeout]).finally(() => clearTimeout(timer));
}

function closeWebSocketServer(wss) {
  if (!wss) return Promise.resolve();
  for (const ws of wss.clients || []) {
    try {
      if (ws.readyState === ws.OPEN || ws.readyState === 1) ws.close(WEBSOCKET_CLOSE_CODE, WEBSOCKET_CLOSE_REASON);
    } catch (_) {
      // The bounded timeout terminates sockets that reject a normal close.
    }
  }
  return new Promise((resolve) => {
    try { wss.close(resolve); } catch (_) { resolve(); }
  });
}

function terminateRemainingSockets(wss) {
  for (const ws of wss?.clients || []) {
    try { if (ws.terminate) ws.terminate(); } catch (_) { /* best effort */ }
  }
}

function trackHttpSockets(server) {
  const sockets = new Set();
  if (!server?.on) return { sockets, detach: () => {} };
  const onConnection = (socket) => {
    sockets.add(socket);
    socket.once?.("close", () => sockets.delete(socket));
  };
  server.on("connection", onConnection);
  return {
    sockets,
    detach: () => server.removeListener?.("connection", onConnection)
  };
}

function createShutdownController({
  server,
  wss,
  schedulers = [],
  prisma,
  log = () => {},
  processRef = process,
  setShuttingDown = () => {},
  cleanup = async () => {},
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
} = {}) {
  let shutdownPromise = null;
  let shuttingDown = false;
  let prismaDisconnected = false;
  let signalUnregister = null;
  const httpSockets = trackHttpSockets(server);

  async function shutdown(signal = "unknown") {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      const startedAt = Date.now();
      const warnings = [];
      setShuttingDown(true);
      log(`[Monitor TI] shutdown iniciado sinal=${signal}`);
      const remainingMs = () => Math.max(1, timeoutMs - (Date.now() - startedAt));

      for (const scheduler of schedulers) {
        if (!scheduler?.stop) continue;
        try {
          const stopped = await withTimeout(
            Promise.resolve().then(() => scheduler.stop()),
            remainingMs(),
            () => warnings.push("scheduler stop timeout")
          );
          if (!stopped) warnings.push("scheduler stop timeout");
        } catch (error) { warnings.push(`scheduler: ${safeError(error)}`); }
      }

      try {
        const cleanupResult = await withTimeout(cleanup(), remainingMs(), () => warnings.push("cleanup timeout"));
        if (!cleanupResult) warnings.push("cleanup timeout");
      } catch (error) { warnings.push(`cleanup: ${safeError(error)}`); }

      let httpClosed = Promise.resolve();
      if (server) {
        httpClosed = new Promise((resolve, reject) => {
          try { server.close((error) => error ? reject(error) : resolve()); }
          catch (error) { reject(error); }
        });
        server.closeIdleConnections?.();
      }

      if (wss) {
        try { wss.stopHeartbeat?.(); }
        catch (error) { warnings.push(`heartbeat: ${safeError(error)}`); }
        try {
          const wsClosed = await withTimeout(
            closeWebSocketServer(wss),
            Math.min(WEBSOCKET_SHUTDOWN_TIMEOUT_MS, remainingMs()),
            () => {
              warnings.push("WebSocket close timeout");
              terminateRemainingSockets(wss);
            }
          );
          if (!wsClosed) terminateRemainingSockets(wss);
        } catch (error) { warnings.push(`WebSocket: ${safeError(error)}`); }
        terminateRemainingSockets(wss);
      }

      try {
        const httpResult = await withTimeout(
          httpClosed,
          Math.min(HTTP_SHUTDOWN_TIMEOUT_MS, remainingMs()),
          () => {
            warnings.push("HTTP close timeout");
            server?.closeAllConnections?.();
            for (const socket of httpSockets.sockets) socket.destroy?.();
          }
        );
        if (!httpResult) for (const socket of httpSockets.sockets) socket.destroy?.();
      } catch (error) { warnings.push(`HTTP: ${safeError(error)}`); }

      if (prisma && !prismaDisconnected) {
        prismaDisconnected = true;
        try {
          const prismaResult = await withTimeout(
            prisma.$disconnect(),
            Math.min(PRISMA_SHUTDOWN_TIMEOUT_MS, remainingMs()),
            () => warnings.push("Prisma disconnect timeout")
          );
          if (!prismaResult) warnings.push("Prisma disconnect timeout");
        } catch (error) { warnings.push(`Prisma: ${safeError(error)}`); }
      }

      httpSockets.detach();
      processRef.exitCode = 0;
      if (warnings.length) log(`[Monitor TI] shutdown finalizado com avisos: ${warnings.join("; ")}`);
      else log("[Monitor TI] shutdown finalizado");
      return { timedOut: warnings.length > 0, exitCode: 0, warnings };
    })();
    return shutdownPromise;
  }

  function registerSignals(target = processRef) {
    if (!target?.once) return () => {};
    if (signalUnregister) return signalUnregister;
    const onTerm = () => { shutdown("SIGTERM"); };
    const onInt = () => { shutdown("SIGINT"); };
    target.once("SIGTERM", onTerm);
    target.once("SIGINT", onInt);
    signalUnregister = () => {
      if (target.removeListener) {
        target.removeListener("SIGTERM", onTerm);
        target.removeListener("SIGINT", onInt);
      }
      signalUnregister = null;
    };
    return signalUnregister;
  }

  return { shutdown, registerSignals, isShuttingDown: () => shuttingDown };
}

function safeError(error) {
  return String(error?.message || error || "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  WEBSOCKET_SHUTDOWN_TIMEOUT_MS,
  HTTP_SHUTDOWN_TIMEOUT_MS,
  PRISMA_SHUTDOWN_TIMEOUT_MS,
  createShutdownController,
  closeWebSocketServer
};
