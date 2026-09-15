const { getCertificadosSyncEnabled, getCertificadosSyncIntervalMinutes } = require("../config");
const syncService = require("./certificateCatalogSync.service");
const { logEvent } = require("../logger");

const INITIAL_DELAY_MS = 60 * 1000;

function createCertificateCatalogSyncScheduler({ service = syncService, enabled = getCertificadosSyncEnabled(), intervalMinutes = getCertificadosSyncIntervalMinutes(), initialDelayMs = INITIAL_DELAY_MS, log = logEvent } = {}) {
  let initialTimer = null;
  let intervalTimer = null;
  let started = false;

  async function tick() {
    try { await service.runAutomatic(); } catch { log("[Monitor TI] sincronizacao_catalogo gatilho=AUTOMATICA status=ERRO_CONTIDO"); }
  }

  function start() {
    if (started || !enabled) return false;
    started = true;
    initialTimer = setTimeout(() => {
      initialTimer = null;
      tick();
      intervalTimer = setInterval(tick, intervalMinutes * 60 * 1000);
      if (typeof intervalTimer.unref === "function") intervalTimer.unref();
    }, initialDelayMs);
    if (typeof initialTimer.unref === "function") initialTimer.unref();
    log(`[Monitor TI] scheduler_catalogo iniciado intervaloMinutos=${intervalMinutes} atrasoInicialMs=${initialDelayMs}`);
    return true;
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
    started = false;
  }

  return { start, stop, tick, isStarted: () => started, intervalMinutes, initialDelayMs, enabled };
}

const defaultScheduler = createCertificateCatalogSyncScheduler();
module.exports = { INITIAL_DELAY_MS, createCertificateCatalogSyncScheduler, ...defaultScheduler };
