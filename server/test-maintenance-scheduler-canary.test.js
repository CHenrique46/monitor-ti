const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");

const { createMaintenanceSchedulerCanaryRouter, isLoopbackAddress } = require("./src/routes/maintenanceSchedulerCanary.routes");

const validBody = { scheduleId: 1, scheduledFor: "2026-09-03T23:00:00.000Z", dryRun: true };
const validSchedule = { id: 1, enabled: false, targetMode: "SELECTED", targets: [{ computadorId: 15 }] };

async function request({ body = validBody, flag = "true", remoteAddress = "127.0.0.1", schedule = validSchedule } = {}) {
  const calls = [];
  const scheduler = {
    getSchedule: async () => schedule,
    runScheduleCycle: async (input) => { calls.push(input); return { mode: input.dryRun ? "DRY_RUN" : "REAL" }; }
  };
  const app = express();
  app.use(express.json());
  app.use("/internal/maintenance-scheduler/canary", createMaintenanceSchedulerCanaryRouter({
    schedulerService: scheduler,
    env: { MAINTENANCE_SCHEDULER_CANARY_ENABLED: flag },
    getRemoteAddress: () => remoteAddress
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/maintenance-scheduler/canary`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json(), calls };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("canary route accepts only loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("192.168.40.133"), false);
});

test("feature flag ausente ou false bloqueia a rota", async () => {
  assert.equal((await request({ flag: "" })).status, 404);
  assert.equal((await request({ flag: "false" })).status, 404);
});

test("conexão remota é rejeitada", async () => {
  const result = await request({ remoteAddress: "192.168.40.133" });
  assert.equal(result.status, 403);
  assert.equal(result.calls.length, 0);
});

test("policy enabled, ALL, zero ou múltiplos targets são rejeitados", async () => {
  for (const schedule of [
    { ...validSchedule, enabled: true },
    { ...validSchedule, targetMode: "ALL" },
    { ...validSchedule, targets: [] },
    { ...validSchedule, targets: [{ computadorId: 15 }, { computadorId: 16 }] }
  ]) {
    const result = await request({ schedule });
    assert.equal(result.status, 409);
    assert.equal(result.calls.length, 0);
  }
});

test("SELECTED com exatamente um target permite dryRun=true", async () => {
  const result = await request({ body: validBody });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [{ scheduleId: 1, scheduledFor: validBody.scheduledFor, dryRun: true, requireEnabled: false }]);
});

test("dryRun=false chama o hook somente com escopo controlado", async () => {
  const result = await request({ body: { ...validBody, dryRun: false } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [{ scheduleId: 1, scheduledFor: validBody.scheduledFor, dryRun: false, requireEnabled: false }]);
});

test("campos extras são rejeitados e não chegam ao hook", async () => {
  const result = await request({ body: { ...validBody, action: "system_maintenance", computadorId: 15, payload: {} } });
  assert.equal(result.status, 400);
  assert.equal(result.calls.length, 0);
});

test("scheduledFor inválido e schedule inexistente são rejeitados", async () => {
  const invalidDate = await request({ body: { ...validBody, scheduledFor: "not-a-date" } });
  assert.equal(invalidDate.status, 400);
  assert.equal(invalidDate.calls.length, 0);
  const missing = await request({ schedule: null });
  assert.equal(missing.status, 404);
  assert.equal(missing.calls.length, 0);
});
