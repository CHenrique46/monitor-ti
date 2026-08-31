const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRemoteActionRuntime,
  createSpoolerResetExecutor,
  createServiceRestartExecutor
} = require("./src/remoteActions");

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(payload) {
      sent.push(JSON.parse(payload));
    }
  };
}

test("spooler_reset sucesso completo executa stop -> clear -> start", async () => {
  const calls = [];
  const exec = createSpoolerResetExecutor({
    timeoutMs: 100,
    stopService: async () => calls.push("stop"),
    clearPrintQueue: async () => calls.push("clear"),
    startService: async () => calls.push("start")
  });

  const result = await exec();
  assert.deepEqual(calls, ["stop", "clear", "start"]);
  assert.deepEqual(result, { spooler: "restarted" });
});

test("remote_action desconhecida vira REJECTED sem executar", async () => {
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    executeSpoolerReset: async () => {
      runs += 1;
      return { spooler: "restarted" };
    },
    getDeviceId: () => "dev-1"
  });
  const ws = makeWs();

  const state = await runtime.handleRemoteAction(ws, {
    actionExecutionId: "a1",
    action: "cmd_arbitrario"
  });

  assert.equal(runs, 0);
  assert.equal(state.status, "REJECTED");
  assert.equal(ws.sent[0].status, "REJECTED");
});

test("duplicidade de actionExecutionId nao reexecuta", async () => {
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    executeSpoolerReset: async () => {
      runs += 1;
      return { spooler: "restarted" };
    },
    getDeviceId: () => "dev-dup"
  });
  const ws = makeWs();

  const first = await runtime.handleRemoteAction(ws, {
    actionExecutionId: "same-id",
    action: "spooler_reset"
  });
  const second = await runtime.handleRemoteAction(ws, {
    actionExecutionId: "same-id",
    action: "spooler_reset"
  });

  assert.equal(runs, 1);
  assert.equal(first.status, "SUCCESS");
  assert.equal(second.status, "SUCCESS");
});

test("falha ao parar Spooler resulta em FAILED", async () => {
  const exec = createSpoolerResetExecutor({
    timeoutMs: 100,
    stopService: async () => {
      throw new Error("stop falhou");
    },
    clearPrintQueue: async () => {},
    startService: async () => {}
  });

  await assert.rejects(exec, /falha ao parar Spooler/);
});

test("falha ao limpar fila ainda tenta iniciar Spooler", async () => {
  const calls = [];
  const exec = createSpoolerResetExecutor({
    timeoutMs: 100,
    stopService: async () => calls.push("stop"),
    clearPrintQueue: async () => {
      calls.push("clear");
      throw new Error("clear falhou");
    },
    startService: async () => calls.push("start")
  });

  await assert.rejects(exec, /falha ao limpar fila/);
  assert.deepEqual(calls, ["stop", "clear", "start"]);
});

test("falha ao iniciar Spooler resulta em FAILED", async () => {
  const exec = createSpoolerResetExecutor({
    timeoutMs: 100,
    stopService: async () => {},
    clearPrintQueue: async () => {},
    startService: async () => {
      throw new Error("start falhou");
    }
  });

  await assert.rejects(exec, /falha ao iniciar Spooler/);
});

test("timeout resulta em FAILED", async () => {
  const exec = createSpoolerResetExecutor({
    timeoutMs: 20,
    stopService: async () => new Promise(() => {}),
    clearPrintQueue: async () => {},
    startService: async () => {}
  });

  await assert.rejects(exec, /timeout ao executar spooler_reset/);
});

test("service_restart permitido reinicia Spooler e valida Running", async () => {
  const calls = [];
  const exec = createServiceRestartExecutor("spooler", {
    timeoutMs: 100,
    stopService: async () => calls.push("stop"),
    startService: async () => calls.push("start"),
    getServiceStatus: async () => "Running"
  });
  const result = await exec();

  assert.deepEqual(calls, ["stop", "start"]);
  assert.equal(result.serviceName, "Spooler");
  assert.equal(result.status, "Running");
});

test("service_restart com chave inexistente vira REJECTED", async () => {
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    executeServiceRestart: async () => {
      runs += 1;
    }
  });
  const ws = makeWs();
  const state = await runtime.handleRemoteAction(ws, {
    actionExecutionId: "service-unknown",
    action: "service_restart",
    payload: { serviceKey: "explorer" }
  });

  assert.equal(runs, 0);
  assert.equal(state.status, "REJECTED");
  assert.equal(ws.sent[0].status, "REJECTED");
});

test("service_restart sem serviceKey vira REJECTED", async () => {
  const runtime = createRemoteActionRuntime({ executeServiceRestart: async () => { throw new Error("nao deveria executar"); } });
  const state = await runtime.handleRemoteAction(makeWs(), {
    actionExecutionId: "service-missing-key",
    action: "service_restart",
    payload: {}
  });
  assert.equal(state.status, "REJECTED");
});

test("service_restart com falha ao parar resulta em FAILED", async () => {
  const exec = createServiceRestartExecutor("spooler", {
    timeoutMs: 100,
    stopService: async () => { throw new Error("stop falhou"); },
    startService: async () => {},
    getServiceStatus: async () => "Running"
  });
  await assert.rejects(exec, /falha ao parar/);
});

test("service_restart com falha ao iniciar resulta em FAILED", async () => {
  const exec = createServiceRestartExecutor("spooler", {
    timeoutMs: 100,
    stopService: async () => {},
    startService: async () => { throw new Error("start falhou"); },
    getServiceStatus: async () => "Stopped"
  });
  await assert.rejects(exec, /falha ao iniciar/);
});

test("service_restart com timeout resulta em FAILED", async () => {
  const exec = createServiceRestartExecutor("spooler", {
    timeoutMs: 20,
    stopService: async () => new Promise(() => {}),
    startService: async () => {},
    getServiceStatus: async () => "Running"
  });
  await assert.rejects(exec, /timeout ao executar service_restart/);
});

test("service_restart duplicado nao reexecuta", async () => {
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    executeServiceRestart: async () => {
      runs += 1;
      return { serviceName: "Spooler", status: "Running" };
    }
  });
  const command = { actionExecutionId: "service-same", action: "service_restart", payload: { serviceKey: "spooler" } };
  const first = await runtime.handleRemoteAction(makeWs(), command);
  const second = await runtime.handleRemoteAction(makeWs(), command);

  assert.equal(runs, 1);
  assert.equal(first.status, "SUCCESS");
  assert.equal(second.status, "SUCCESS");
});
