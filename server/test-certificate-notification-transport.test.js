const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");
const agentServer = require("./src/ws/agentServer");

const DEVICE_ID = agentServer.PILOT_DEVICE_ID;
const EVENT_ID = "4dd9e12c-e455-4b44-bf09-025649a47505";
const PILOT_ENV = {
  MTI_CERTIFICATE_NOTIFICATION_TEST: "1",
  MTI_CERTIFICATE_NOTIFICATION_TARGET_DEVICE_ID: DEVICE_ID,
  MTI_CERTIFICATE_NOTIFICATION_EVENT_ID: EVENT_ID
};

function waitFor(predicate, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error("timeout aguardando transporte"));
      setTimeout(check, 5);
    };
    check();
  });
}

function createPrismaMock({ delayed = false } = {}) {
  let releaseUpsert;
  let upsertStarted;
  const upsertReady = new Promise((resolve) => { upsertStarted = resolve; });
  const mock = {
    computador: {
      upsert: async ({ create }) => {
        upsertStarted();
        if (delayed) await new Promise((resolve) => { releaseUpsert = resolve; });
        return { id: 15, ...create };
      },
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ id: 15 })
    },
    agentUpdate: { findFirst: async () => null },
    $transaction: async (callback) => callback({
      discoFisico: { deleteMany: async () => {}, createMany: async () => {} }
    })
  };
  return { mock, upsertReady, release: () => releaseUpsert() };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `ws://127.0.0.1:${server.address().port}`;
}

async function openClient(url) {
  const client = new WebSocket(url);
  await new Promise((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
  return client;
}

function register(client, capabilities = []) {
  client.send(JSON.stringify({
    type: "register",
    data: { deviceId: DEVICE_ID, hostname: "TEST-HOST", capabilities }
  }));
}

async function closeAll(wss, server, clients) {
  for (const client of clients) {
    if (client && client.readyState !== WebSocket.CLOSED) client.close();
  }
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}

test("capabilities antes do register são mantidas e o piloto envia somente após registro", async () => {
  agentServer.reloadPilotConfigForTests(PILOT_ENV);
  const db = createPrismaMock({ delayed: true });
  const server = http.createServer();
  const wss = agentServer.setupWebSocket(server, {
    prisma: db.mock,
    avisosService: { obterPendentesDoDispositivo: async () => [] }
  });
  const url = await listen(server);
  const client = await openClient(url);
  const received = [];
  client.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    if (message.type === "certificate_notification_test") {
      client.send(JSON.stringify({
        type: "certificate_notification_test_ack",
        eventId: message.eventId,
        status: "RECEIVED"
      }));
      client.send(JSON.stringify({
        type: "certificate_notification_test_ack",
        eventId: message.eventId,
        status: "DISPLAYED"
      }));
    }
  });

  try {
    client.send(JSON.stringify({ type: "capabilities", deviceId: DEVICE_ID, data: { capabilities: ["notices"] } }));
    client.send(JSON.stringify({ type: "capabilities", deviceId: DEVICE_ID, data: { capabilities: [agentServer.PILOT_CAPABILITY] } }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.some((message) => message.type === "certificate_notification_test"), false);

    register(client);
    await db.upsertReady;
    assert.equal(agentServer.getPilotStateForTests(), "pending");
    db.release();
    await waitFor(() => received.some((message) => message.type === "certificate_notification_test"));
    await waitFor(() => agentServer.getPilotStateForTests() === "acknowledged");
    assert.equal(received.filter((message) => message.type === "certificate_notification_test").length, 1);
    assert.deepEqual(new Set(agentServer.getCapabilities(DEVICE_ID)), new Set(["notices", agentServer.PILOT_CAPABILITY]));
  } finally {
    agentServer.reloadPilotConfigForTests({});
    await closeAll(wss, server, [client]);
  }
});

test("conexão nova substitui a antiga e o close antigo não remove a atual", async () => {
  agentServer.reloadPilotConfigForTests({});
  const db = createPrismaMock();
  const server = http.createServer();
  const wss = agentServer.setupWebSocket(server, {
    prisma: db.mock,
    avisosService: { obterPendentesDoDispositivo: async () => [] }
  });
  const url = await listen(server);
  const oldClient = await openClient(url);
  const newClient = await openClient(url);
  const oldMessages = [];
  const newMessages = [];
  oldClient.on("message", (raw) => oldMessages.push(JSON.parse(raw.toString())));
  newClient.on("message", (raw) => newMessages.push(JSON.parse(raw.toString())));

  try {
    register(oldClient, ["notices"]);
    await waitFor(() => oldMessages.some((message) => message.type === "register_ack"));
    register(newClient, ["notices"]);
    await waitFor(() => newMessages.some((message) => message.type === "register_ack"));
    oldClient.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(agentServer.sendToAgent(DEVICE_ID, { type: "transport_probe" }), true);
    await waitFor(() => newMessages.some((message) => message.type === "transport_probe"));
    assert.equal(oldMessages.some((message) => message.type === "transport_probe"), false);
  } finally {
    await closeAll(wss, server, [oldClient, newClient]);
  }
});

test("callback de envio controla sent e erro não dispara retry", async () => {
  agentServer.reloadPilotConfigForTests(PILOT_ENV);
  agentServer.setCapabilities(DEVICE_ID, ["notices", agentServer.PILOT_CAPABILITY]);
  let sendCount = 0;
  const sentSocket = {
    connectionId: "test-success",
    deviceId: DEVICE_ID,
    registered: true,
    readyState: 1,
    send: (payload, callback) => { sendCount += 1; callback(); }
  };
  assert.equal(agentServer.sendCertificateNotificationTest(DEVICE_ID, undefined, sentSocket), true);
  assert.equal(agentServer.sendCertificateNotificationTest(DEVICE_ID, undefined, sentSocket), false);
  assert.equal(sendCount, 1);
  assert.equal(agentServer.getPilotStateForTests(), "sent");

  agentServer.reloadPilotConfigForTests(PILOT_ENV);
  const failedSocket = {
    connectionId: "test-failure",
    deviceId: DEVICE_ID,
    registered: true,
    readyState: 1,
    send: (payload, callback) => callback(new Error("raw error must not be logged"))
  };
  assert.equal(agentServer.sendCertificateNotificationTest(DEVICE_ID, undefined, failedSocket), true);
  assert.equal(agentServer.getPilotStateForTests(), "failed");
  assert.equal(agentServer.sendCertificateNotificationTest(DEVICE_ID, undefined, failedSocket), false);

  agentServer.reloadPilotConfigForTests(PILOT_ENV);
  const closedSocket = { connectionId: "test-closed", deviceId: DEVICE_ID, registered: true, readyState: 0, send: () => { throw new Error("must not send"); } };
  assert.equal(agentServer.sendCertificateNotificationTest(DEVICE_ID, undefined, closedSocket), false);
  assert.equal(agentServer.getPilotStateForTests(), "pending");
  agentServer.reloadPilotConfigForTests({});
});
