const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
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
      // O timeout encerra sockets que não aceitem o fechamento normal.
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

function createShutdownController({
  server,
  wss,
  schedulers = [],
  prisma,
  log = () => {},
  processRef = process,
  setShuttingDown = () => {},
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
} = {}) {
  let shutdownPromise = null;
  let prismaDisconnected = false;
  let signalUnregister = null;

  async function shutdown(signal = "unknown") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const startedAt = Date.now();
      let timedOut = false;
      let failed = false;
      setShuttingDown(true);
      log(`[Monitor TI] shutdown iniciado sinal=${signal}`);

      for (const scheduler of schedulers) {
        try { if (scheduler?.stop) scheduler.stop(); } catch (error) { failed = true; log(`[Monitor TI] erro ao parar recurso: ${safeError(error)}`); }
      }

      const remainingMs = () => Math.max(1, timeoutMs - (Date.now() - startedAt));
      let httpClosed = Promise.resolve();
      if (server) {
        httpClosed = new Promise((resolve, reject) => {
          try { server.close((error) => error ? reject(error) : resolve()); }
          catch (error) { reject(error); }
        });
        if (server.closeIdleConnections) server.closeIdleConnections();
      }

      if (wss) {
        try {
          await withTimeout(closeWebSocketServer(wss), remainingMs(), () => { timedOut = true; terminateRemainingSockets(wss); });
        } catch (error) { failed = true; log(`[Monitor TI] erro ao fechar WebSocket: ${safeError(error)}`); }
        terminateRemainingSockets(wss);
      }

      try {
        await withTimeout(httpClosed, remainingMs(), () => {
          timedOut = true;
          if (server?.closeAllConnections) server.closeAllConnections();
        });
      } catch (error) { failed = true; log(`[Monitor TI] erro ao fechar HTTP: ${safeError(error)}`); }

      if (prisma && !prismaDisconnected) {
        prismaDisconnected = true;
        try { await withTimeout(prisma.$disconnect(), remainingMs(), () => { timedOut = true; }); }
        catch (error) { failed = true; log(`[Monitor TI] erro ao desconectar Prisma: ${safeError(error)}`); }
      }

      if (timedOut || failed) {
        processRef.exitCode = 1;
        log(`[Monitor TI] shutdown finalizado${timedOut ? " com timeout" : " com erro"}`);
      } else {
        processRef.exitCode = 0;
        log("[Monitor TI] shutdown finalizado");
      }
      return { timedOut, exitCode: processRef.exitCode };
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

  return { shutdown, registerSignals, isShuttingDown: () => Boolean(shutdownPromise) };
}

function safeError(error) {
  return String(error?.message || error || "erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 240);
}

module.exports = { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownController, closeWebSocketServer };
