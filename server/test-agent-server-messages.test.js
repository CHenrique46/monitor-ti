const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");

const { setupWebSocket } = require("./src/ws/agentServer");
const remoteActionsService = require("./src/services/remoteActions.service");
const logger = require("./src/logger");
const { createRemoteActionsService } = remoteActionsService;

function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error("timeout aguardando teste"));
      setTimeout(check, 5);
    };
    check();
  });
}

test("handler WebSocket isola erro de status e processa a próxima mensagem", async () => {
  const server = http.createServer();
  const wss = setupWebSocket(server);
  const originalApply = remoteActionsService.applyAgentStatusMessage;
  const originalLog = logger.logEvent;
  const logs = [];
  let calls = 0;
  let client;

  remoteActionsService.applyAgentStatusMessage = async () => {
    calls += 1;
    if (calls === 1) throw new Error("falha Prisma simulada");
    return { status: "SUCCESS", mensagem: null, erro: null };
  };
  logger.logEvent = (message) => logs.push(message);

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    client.send(JSON.stringify({
      type: "remote_action_status",
      actionExecutionId: "ws-error-1",
      deviceId: "dev-1",
      action: "system_maintenance",
      status: "SUCCESS",
      result: { secret: "nao deve ir para o log" }
    }));
    await waitFor(() => calls === 1 && logs.length > 0);
    assert.match(logs[0], /ws-error-1/);
    assert.match(logs[0], /system_maintenance/);
    assert.match(logs[0], /SUCCESS/);
    assert.doesNotMatch(logs[0], /nao deve ir para o log/);

    client.send(JSON.stringify({
      type: "remote_action_status",
      actionExecutionId: "ws-valid-2",
      deviceId: "dev-1",
      action: "system_maintenance",
      status: "SUCCESS",
      result: { steps: [] }
    }));
    await waitFor(() => calls === 2);
    assert.equal(calls, 2);
  } finally {
    remoteActionsService.applyAgentStatusMessage = originalApply;
    logger.logEvent = originalLog;
    if (client) client.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Server solicita reconciliacao e envia ACK somente depois da persistencia", async () => {
  const server = http.createServer();
  const record = {
    id: 1,
    actionExecutionId: "ack-1",
    computadorId: 15,
    action: "system_maintenance",
    status: "RUNNING",
    mensagem: null,
    erro: null,
    resultado: null,
    iniciadaEm: new Date(),
    computador: { deviceId: "dev-1" }
  };
  const db = {
    computador: {
      upsert: async ({ create }) => ({ id: 15, ...create })
    },
    acaoRemotaExecucao: {
      findUnique: async ({ where }) => where.actionExecutionId === record.actionExecutionId ? record : null,
      update: async ({ data }) => Object.assign(record, data)
    },
    $transaction: async (callback) => callback({
      discoFisico: { deleteMany: async () => {}, createMany: async () => {} }
    })
  };
  const service = createRemoteActionsService(db);
  const originalLog = logger.logEvent;
  const logs = [];
  logger.logEvent = (message) => logs.push(message);
  const wss = setupWebSocket(server, {
    prisma: db,
    remoteActionsService: service,
    avisosService: { obterPendentesDoDispositivo: async () => [] }
  });
  let socket;

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const messages = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "register",
      data: { deviceId: "dev-1", hostname: "PC-1", discosFisicos: [], capabilities: [] }
    }));
    await waitFor(() => messages.some((message) => message.type === "remote_action_reconcile_request"));
    socket.send(JSON.stringify({
      type: "remote_action_reconcile",
      deviceId: "dev-1",
      executions: [{
        actionExecutionId: "ack-1",
        action: "system_maintenance",
        status: "SUCCESS",
        message: "concluido",
        result: { overallStatus: "SUCCESS" }
      }]
    }));
    await waitFor(() => messages.some((message) => message.type === "remote_action_status_ack"));

    const ack = messages.find((message) => message.type === "remote_action_status_ack");
    const reconciliation = messages.find((message) => message.type === "remote_action_reconcile_result");
    assert.equal(record.status, "SUCCESS");
    assert.equal(ack.actionExecutionId, "ack-1");
    assert.deepEqual(reconciliation.accepted, ["ack-1"]);
    assert.ok(logs.some((message) => message.includes("remote_action_reconcile_request_sent") && message.includes("computadorId=15")));
    assert.ok(logs.some((message) => message.includes("remote_action_reconcile_received") && message.includes("count=1")));
    assert.ok(logs.some((message) => message.includes("remote_action_reconcile_processed") && message.includes("accepted=1") && message.includes("acked=1")));
    assert.ok(logs.some((message) => message.includes("remote_action_status_ack_sent") && message.includes("ack-1") && message.includes("SUCCESS")));
    assert.equal(logs.some((message) => message.includes("overallStatus")), false);
  } finally {
    logger.logEvent = originalLog;
    if (socket) socket.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
