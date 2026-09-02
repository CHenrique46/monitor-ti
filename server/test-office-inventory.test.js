const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");
const { validateInventoryMessage, MAX_INSTALLATIONS, MAX_WARNINGS } = require("./src/inventory/office");
const { setupWebSocket } = require("./src/ws/agentServer");
const logger = require("./src/logger");

function validMessage() {
  return {
    type: "inventory",
    deviceId: "dev-1",
    data: {
      office: {
        collectedAt: "2026-09-02T12:00:00.000Z",
        installations: [{ source: "OSPP", productName: "Office", partialProductKey: "ABCDE", fingerprint: "f1" }],
        warnings: []
      }
    }
  };
}

test("valid inventory and inventory without Office are accepted", () => {
  assert.deepEqual(validateInventoryMessage(validMessage(), "dev-1"), { ok: true, installationCount: 1 });
  const empty = validMessage();
  empty.data.office.installations = [];
  assert.deepEqual(validateInventoryMessage(empty, "dev-1"), { ok: true, installationCount: 0 });
});

test("inventory validation rejects malformed, excessive and sensitive payloads", () => {
  const malformed = validMessage();
  delete malformed.data.office;
  assert.equal(validateInventoryMessage(malformed, "dev-1").ok, false);

  const excessive = validMessage();
  excessive.data.office.installations = Array.from({ length: MAX_INSTALLATIONS + 1 }, () => ({}));
  assert.equal(validateInventoryMessage(excessive, "dev-1").reason, "installations_limit");

  const warnings = validMessage();
  warnings.data.office.warnings = Array.from({ length: MAX_WARNINGS + 1 }, () => "warning");
  assert.equal(validateInventoryMessage(warnings, "dev-1").reason, "warnings_limit");

  const key = validMessage();
  key.data.office.installations[0].licenseDescription = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
  assert.equal(validateInventoryMessage(key, "dev-1").reason, "sensitive_key");
  assert.equal(validateInventoryMessage(validMessage(), "other-device").reason, "device_mismatch");
});

function createDb() {
  const calls = { upsert: 0, findUnique: 0, officeUpsert: 0, officeUpdateMany: 0 };
  return {
    calls,
    computador: {
      upsert: async ({ create }) => { calls.upsert += 1; return { id: 7, ...create }; },
      findUnique: async ({ where }) => { calls.findUnique += 1; return where.deviceId === "dev-1" ? { id: 7 } : null; },
      updateMany: async () => ({ count: 0 })
    },
    $transaction: async (callback) => callback({
      computador: { findUnique: async ({ where }) => where.id === 7 ? { id: 7 } : null },
      officeInstallation: {
        upsert: async () => { calls.officeUpsert += 1; return {}; },
        updateMany: async () => { calls.officeUpdateMany += 1; return { count: 0 }; }
      },
      discoFisico: { deleteMany: async () => {}, createMany: async () => {} }
    })
  };
}

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => predicate() ? resolve() : Date.now() - started >= timeoutMs ? reject(new Error("timeout")) : setTimeout(check, 5);
    check();
  });
}

test("WebSocket receives valid inventory without persistence or sensitive logs", async () => {
  const server = http.createServer();
  const db = createDb();
  const logs = [];
  const originalLog = logger.logEvent;
  logger.logEvent = (message) => logs.push(message);
  const wss = setupWebSocket(server, { prisma: db, avisosService: { obterPendentesDoDispositivo: async () => [] } });
  let client;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    client.send(JSON.stringify({ type: "register", data: { deviceId: "dev-1", hostname: "PC-1", discosFisicos: [], capabilities: [] } }));
    await waitFor(() => db.calls.upsert === 1);
    client.send(JSON.stringify(validMessage()));
    await waitFor(() => logs.some((message) => message.includes("inventory received")));
    assert.equal(db.calls.officeUpsert, 1);
    assert.equal(db.calls.officeUpdateMany, 1);
    assert.equal(logs.some((message) => message.includes("AAAAA") || message.includes("licenseDescription")), false);
  } finally {
    logger.logEvent = originalLog;
    if (client) client.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("unknown computer inventory is rejected without crashing", async () => {
  const db = createDb();
  const server = http.createServer();
  const logs = [];
  const originalLog = logger.logEvent;
  logger.logEvent = (message) => logs.push(message);
  const wss = setupWebSocket(server, { prisma: db, avisosService: { obterPendentesDoDispositivo: async () => [] } });
  let client;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    client.send(JSON.stringify({ type: "register", data: { deviceId: "dev-unknown", hostname: "PC-1", discosFisicos: [], capabilities: [] } }));
    await waitFor(() => db.calls.upsert === 1);
    const unknown = validMessage();
    unknown.deviceId = "dev-unknown";
    client.send(JSON.stringify(unknown));
    await waitFor(() => logs.some((message) => message.includes("computer_not_found")));
    assert.equal(logs.some((message) => message.includes("inventory received")), false);
  } finally {
    logger.logEvent = originalLog;
    if (client) client.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
