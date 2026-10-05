const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");
const { setupWebSocket } = require("./src/ws/agentServer");
const { normalizeIp } = require("./src/networkIp");

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
        Object.assign(computer, computer.hostname ? update : create);
        computer.status = "online";
        return { ...computer };
      },
      findUnique: async () => ({ ...computer }),
      update: async ({ data }) => { Object.assign(computer, data); return { ...computer }; },
      updateMany: async () => ({ count: 1 })
    },
    discoFisico: { deleteMany: async () => {}, createMany: async () => {} },
    $transaction: async (operation) => operation({ discoFisico: { deleteMany: async () => {}, createMany: async () => {} } })
  };
}

test("preserva o ultimo IP quando register antigo chega sem IP", async () => {
  const server = http.createServer();
  const db = database();
  const wss = setupWebSocket(server, {
    prisma: db,
    avisosService: { obterPendentesDoDispositivo: async () => [] },
    alertasService: { avaliar: async () => {} }
  });
  let first;
  let second;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const connect = (ip) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
      const messages = [];
      socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      socket.once("open", () => socket.send(JSON.stringify({ type: "register", data: { deviceId: "device-77", hostname: "FICTITIOUS-77", ip, discosFisicos: [], capabilities: [] } })));
      socket.once("error", reject);
      waitFor(() => messages.some((message) => message.type === "register_ack")).then(() => resolve(socket), reject);
    });
    first = await connect("192.168.40.77");
    await waitFor(() => db.computer.ip === "192.168.40.77");
    first.close();
    await new Promise((resolve) => first.once("close", resolve));
    second = await connect("");
    await waitFor(() => db.calls.length === 2);
    assert.equal(db.computer.ip, "192.168.40.77");
    assert.equal(db.calls[1].update.ip, undefined);
  } finally {
    if (first) first.close();
    if (second) second.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("metrics.ip normalizado atualiza o IP sem fallback de socket", async () => {
  const server = http.createServer();
  const db = database();
  const wss = setupWebSocket(server, {
    prisma: db,
    avisosService: { obterPendentesDoDispositivo: async () => [] },
    alertasService: { avaliar: async () => {} }
  });
  let socket;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "register", data: { deviceId: "device-77", hostname: "FICTITIOUS-77", ip: "192.168.40.77", discosFisicos: [], capabilities: [] } }));
    await waitFor(() => messages.some((message) => message.type === "register_ack"));
    socket.send(JSON.stringify({ type: "metrics", data: { deviceId: "device-77", ip: "::ffff:192.168.40.88", cpu: 1, ramTotal: 2, ramUsada: 1, discoTotal: 3, discoLivre: 2, uptime: 4 } }));
    await waitFor(() => db.computer.ip === "192.168.40.88");
    assert.equal(normalizeIp("::ffff:192.168.40.88"), "192.168.40.88");
    socket.send(JSON.stringify({ type: "metrics", data: { deviceId: "device-77", cpu: 1, ramTotal: 2, ramUsada: 1, discoTotal: 3, discoLivre: 2, uptime: 5 } }));
    await waitFor(() => db.computer.ultimaMetrica instanceof Date);
    assert.equal(db.computer.ip, "192.168.40.88");
  } finally {
    if (socket) socket.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
