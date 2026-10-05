const assert = require("node:assert/strict");
const test = require("node:test");
const { createCertificateReleaseCleanupScheduler, startConfiguredCertificateReleaseCleanupScheduler } = require("./src/services/certificateReleaseCleanupScheduler.service");

function serviceMock() {
  const calls = [];
  return {
    calls,
    async expireRetryAuthorizations() { calls.push("expire"); return { expired: 0 }; },
    async recoverStaleRemovals() { calls.push("stale"); return { recovered: 0 }; },
    async recoverAbandonedAttempts() { calls.push("abandoned"); return { recovered: 0 }; },
    async cleanupExpired() { calls.push("cleanup"); return { expired: 0, removed: 0 }; },
    async stopRecovery() { calls.push("stop"); }
  };
}

test("scheduler inicia uma vez e não executa trabalho após parada", async () => {
  const service = serviceMock();
  const scheduler = createCertificateReleaseCleanupScheduler({ service, intervalMs: 60_000, log: () => {} });
  assert.equal(scheduler.start(), true);
  assert.equal(scheduler.start(), false);
  await new Promise((resolve) => setImmediate(resolve));
  await scheduler.stop();
  const callsAfterStop = service.calls.length;
  await scheduler.tick();
  assert.equal(service.calls.length, callsAfterStop);
  assert.equal(service.calls.at(-1), "stop");
});

test("configuração ausente desabilita o scheduler sem iniciar cleanup", () => {
  const service = serviceMock();
  const scheduler = createCertificateReleaseCleanupScheduler({ service, log: () => {} });
  const logs = [];
  const state = startConfiguredCertificateReleaseCleanupScheduler({
    scheduler,
    getDestinationPath: () => { throw Object.assign(new Error("missing"), { code: "RELEASE_DESTINATION_INVALID" }); },
    log: (message) => logs.push(message)
  });
  assert.deepEqual(state, { started: false, state: "DISABLED_CONFIG_INVALID", destinationPath: null, code: "RELEASE_DESTINATION_INVALID" });
  assert.equal(scheduler.isStarted(), false);
  assert.deepEqual(service.calls, []);
  assert.match(logs[0], /state=DISABLED_CONFIG_INVALID/);
});
