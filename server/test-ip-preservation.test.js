const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");
const { setupWebSocket } = require("./src/ws/agentServer");
const { normalizeIp } = require("./src/networkIp");
const { createPortalService } = require("./src/services/portal.service");
const { IP_CONFIRMATION_TTL_MS, agentIpConfirmation, createAgentIpConfirmationService } = require("./src/services/agentIpConfirmation.service");
const logger = require("./src/logger");

function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => predicate() ? resolve() : Date.now() - started >= timeoutMs ? reject(new Error("timeout")) : setTimeout(check, 5);
    check();
  });
}

function database() {
  const computer = { id: 77, deviceId: "device-77", hostname: "FICTITIOUS-77", ip: null, status: "offline" };
  const calls = [];
  return {
    computer,
    calls,
    computador: {
      upsert: async ({ create, update }) => {
        calls.push({ create, update });
        if (!computer.hostname) Object.assign(computer, create);
        Object.assign(computer, update);
        computer.status = "online";
        return { ...computer };
      },
      findUnique: async () => ({ ...computer }),
      findMany: async () => [{ ...computer }],
      update: async ({ data }) => { Object.assign(computer, data); return { ...computer }; },
      updateMany: async () => ({ count: 1 })
    },
    discoFisico: { deleteMany: async () => {}, createMany: async () => {} },
    $transaction: async (operation) => operation({ discoFisico: { deleteMany: async () => {}, createMany: async () => {} } })
  };
}

test("normaliza IPv4 mapeado, IPv6 equivalente e endereço com zone id", () => {
  assert.equal(normalizeIp("::ffff:192.168.40.77"), "192.168.40.77");
  assert.equal(normalizeIp("2001:0DB8:0:0:0:0:0:77"), "2001:db8::77");
  assert.equal(normalizeIp("fe80::77%12"), "fe80::77");
  assert.equal(normalizeIp("not-an-ip"), null);
});

test("registro inicial e reconexão sem IP preservam o IP por deviceId", async () => {
  const server = http.createServer();
  const db = database();
  const logs = [];
  const originalLog = logger.logEvent;
  logger.logEvent = (message) => logs.push(message);
  const wss = setupWebSocket(server, { prisma: db, avisosService: { obterPendentesDoDispositivo: async () => [] }, alertasService: { avaliar: async () => {} } });
  let first;
  let second;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connectAndRegister = (ip) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      const messages = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      socket.once("open", () => socket.send(JSON.stringify({ type: "register", data: { deviceId: "device-77", hostname: "FICTITIOUS-77", ip, discosFisicos: [], capabilities: [] } })));
      socket.once("error", reject);
      waitFor(() => messages.some((message) => message.type === "register_ack")).then(() => resolve(socket), reject);
    });
    first = await connectAndRegister("192.168.40.77");
    await waitFor(() => db.computer.ip === "192.168.40.77");
    first.close();
    await new Promise((resolve) => first.once("close", resolve));
    second = await connectAndRegister("");
    await waitFor(() => db.calls.length === 2);
    assert.equal(db.computer.ip, "192.168.40.77");
    assert.equal(db.calls[1].update.ip, undefined);
    assert.ok(logs.some((message) => message.includes("socketIp=127.0.0.1") && message.includes("reportedIp=-") && message.includes("persistedIp=192.168.40.77")));
  } finally {
    logger.logEvent = originalLog;
    if (first) first.close();
    if (second) second.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("IP antigo continua visível, mas não autoriza portal sem confirmação da conexão atual", async () => {
  const computers = [{ id: 77, deviceId: "device-77", ip: "192.168.40.77", hostname: "FICTITIOUS-77", status: "online" }];
  const db = { computador: { findMany: async () => computers } };
  const confirmation = createAgentIpConfirmationService();
  const portal = createPortalService({ db, ipConfirmation: confirmation });

  confirmation.confirm("device-77", "connection-a", "192.168.40.77");
  const oldSession = await portal.createSession("192.168.40.77");

  confirmation.clear("device-77", "connection-a");
  assert.equal(computers[0].ip, "192.168.40.77");
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
  assert.equal(await portal.getSession(oldSession.id, "192.168.40.77"), null);

  computers[0].ip = "192.168.40.88";
  confirmation.confirm("device-77", "connection-b", "192.168.40.88");
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
  assert.equal((await portal.createSession("192.168.40.88")).computer.id, 77);
});

test("IP compartilhado não escolhe automaticamente entre duas máquinas confirmadas", async () => {
  const db = { computador: { findMany: async () => [
    { id: 77, deviceId: "device-77", ip: "192.168.40.77", status: "online" },
    { id: 78, deviceId: "device-78", ip: "192.168.40.77", status: "online" }
  ] } };
  const confirmation = createAgentIpConfirmationService();
  const portal = createPortalService({ db, ipConfirmation: confirmation });
  confirmation.confirm("device-77", "connection-77", "192.168.40.77");
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_AMBIGUOUS" });
  confirmation.confirm("device-78", "connection-78", "192.168.40.77");
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_AMBIGUOUS" });
});

test("reinício do Server invalida confirmações até um novo register", async () => {
  const confirmation = createAgentIpConfirmationService();
  const computers = [{ id: 77, deviceId: "device-77", ip: "192.168.40.77", status: "online" }];
  const portal = createPortalService({ db: { computador: { findMany: async () => computers } }, ipConfirmation: confirmation });
  confirmation.confirm("device-77", "connection-before-restart", "192.168.40.77");
  const session = await portal.createSession("192.168.40.77");
  confirmation.reset();
  assert.equal(await portal.getSession(session.id, "192.168.40.77"), null);
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
  confirmation.confirm("device-77", "connection-after-register", "192.168.40.77");
  assert.equal((await portal.createSession("192.168.40.77")).computer.id, 77);
});

test("close tardio da conexão antiga não remove confirmação da conexão nova", () => {
  const confirmation = createAgentIpConfirmationService();
  confirmation.confirm("device-77", "connection-old", "192.168.40.77");
  confirmation.confirm("device-77", "connection-new", "192.168.40.88");
  confirmation.clear("device-77", "connection-old");
  assert.equal(confirmation.isConfirmed("device-77", "192.168.40.77"), false);
  assert.equal(confirmation.isConfirmed("device-77", "192.168.40.88"), true);
});

test("IP A fica obsoleto após o TTL e a nova confirmação B reabre a autorização", async () => {
  let now = 1000;
  const confirmation = createAgentIpConfirmationService({ now: () => now });
  const computers = [{ id: 77, deviceId: "device-77", ip: "192.168.40.77", status: "online" }];
  const portal = createPortalService({ db: { computador: { findMany: async () => computers } }, ipConfirmation: confirmation });
  confirmation.confirm("device-77", "connection-current", "192.168.40.77");
  assert.equal((await portal.createSession("192.168.40.77")).computer.id, 77);
  now += IP_CONFIRMATION_TTL_MS + 1;
  await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
  computers[0].ip = "192.168.40.88";
  confirmation.confirm("device-77", "connection-current", "192.168.40.88");
  assert.equal((await portal.createSession("192.168.40.88")).computer.id, 77);
});

test("mudança de IP com WebSocket ativo só autoriza após novo register", async () => {
  const server = http.createServer();
  const db = database();
  const portal = createPortalService({ db, ipConfirmation: agentIpConfirmation });
  const wss = setupWebSocket(server, { prisma: db, avisosService: { obterPendentesDoDispositivo: async () => [] }, alertasService: { avaliar: async () => {} } });
  const messages = [];
  let socket;
  agentIpConfirmation.reset();
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const register = (ip) => socket.send(JSON.stringify({ type: "register", data: { deviceId: "device-77", hostname: "FICTITIOUS-77", ip, discosFisicos: [], capabilities: [] } }));
    register("192.168.40.77");
    await waitFor(() => messages.some((message) => message.type === "register_ack"));
    assert.equal((await portal.createSession("192.168.40.77")).computer.id, 77);
    await assert.rejects(() => portal.createSession("192.168.40.88"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
    socket.send(JSON.stringify({ type: "metrics", data: { deviceId: "device-77", ip: "192.168.40.88", cpu: 1, ramTotal: 2, ramUsada: 1, discoTotal: 3, discoLivre: 2, uptime: 4 } }));
    await waitFor(() => db.computer.ip === "192.168.40.88");
    await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
    assert.equal((await portal.createSession("192.168.40.88")).computer.id, 77);
    register("192.168.40.88");
    await waitFor(() => db.computer.ip === "192.168.40.88");
    await assert.rejects(() => portal.createSession("192.168.40.77"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
    assert.equal((await portal.createSession("192.168.40.88")).computer.id, 77);
  } finally {
    agentIpConfirmation.reset();
    if (socket) socket.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
