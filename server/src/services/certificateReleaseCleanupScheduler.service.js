const { CLEANUP_INTERVAL_MS } = require("./certificateRelease.service");
const { logEvent } = require("../logger");

function createCertificateReleaseCleanupScheduler({ service, intervalMs = CLEANUP_INTERVAL_MS, log = logEvent } = {}) {
  let timer = null;
  let started = false;
  let tickInProgress = false;
  let stopping = false;

  async function tick() {
    if (stopping || tickInProgress) return { skipped: true };
    tickInProgress = true;
    const startedAt = Date.now();
    log("[Monitor TI] release_cleanup cycle=start");
    try {
      const authorizations = service.expireRetryAuthorizations ? await service.expireRetryAuthorizations() : { expired: 0 };
      const removalRecovery = service.recoverStaleRemovals ? await service.recoverStaleRemovals() : { skipped: true };
      const recovery = service.recoverAbandonedAttempts ? await service.recoverAbandonedAttempts() : { skipped: true };
      const cleanup = await service.cleanupExpired();
      log(`[Monitor TI] release_cleanup cycle=complete durationMs=${Date.now() - startedAt} candidatesNormal=${removalRecovery.normalCandidates || 0} candidatesExtraordinary=${removalRecovery.extraordinaryCandidates || 0} acquisitionsExtraordinary=${removalRecovery.extraordinary || 0} backoffSkipped=${removalRecovery.backoffSkipped || 0} authorizationExpired=${authorizations.expired || 0}`);
      return { authorizations, removalRecovery, recovery, cleanup };
    }
    catch { log("[Monitor TI] release_cleanup status=ERRO_CONTIDO"); return null; }
    finally { tickInProgress = false; }
  }

  function start() {
    if (started) return false;
    started = true;
    stopping = false;
    tick();
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return true;
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    started = false;
    stopping = true;
    try { await service.stopRecovery?.(); } catch (_) {}
  }

  return { start, stop, tick, isStarted: () => started, intervalMs };
}

module.exports = { createCertificateReleaseCleanupScheduler };
