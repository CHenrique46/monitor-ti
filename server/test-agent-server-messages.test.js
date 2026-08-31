const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");

const { setupWebSocket } = require("./src/ws/agentServer");
const remoteActionsService = require("./src/services/remoteActions.service");
const logger = require("./src/logger");

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
