const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRemoteActionRuntime,
  createSpoolerResetExecutor,
  createServiceRestartExecutor,
  createSystemMaintenanceExecutor
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

function maintenanceSuccessDeps(overrides = {}) {
  return {
    cleanupTemp: async () => ({ roots: [], blocked: [], errors: [] }),
    runSfc: async () => ({ exitCode: 0, durationMs: 120, stdout: "", stderr: "" }),
    runDism: async () => ({ exitCode: 0, durationMs: 240, stdout: "", stderr: "" }),
    flushDns: async () => ({ exitCode: 0, durationMs: 30, stdout: "", stderr: "" }),
    notifyUser: async () => ({ ok: true }),
    ...overrides
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

test("system_maintenance executa todas as etapas sequencialmente", async () => {
  const calls = [];
  const exec = createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    cleanupTemp: async () => { calls.push("cleanup"); return { roots: [], blocked: [], errors: [] }; },
    runSfc: async () => { calls.push("sfc"); return { exitCode: 0, durationMs: 120, stdout: "", stderr: "" }; },
    runDism: async () => { calls.push("dism"); return { exitCode: 0, durationMs: 240, stdout: "", stderr: "" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 30, stdout: "", stderr: "" }; }
  }));
  const result = await exec();

  assert.deepEqual(calls, ["cleanup", "sfc", "dism", "dns"]);
  assert.equal(result.overallStatus, "SUCCESS");
  assert.deepEqual(result.steps.map((step) => step.key), ["temp_cleanup", "sfc", "dism", "dns_flush"]);
  assert.equal(result.steps.every((step) => step.status === "SUCCESS"), true);
  assert.equal(result.rebootRecommended, true);
  assert.equal(result.notification.status, "SUCCESS");
});

test("system_maintenance registra limpeza parcial por arquivo bloqueado", async () => {
  const exec = createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    cleanupTemp: async () => ({
      roots: [],
      blocked: [{ path: "C:\\temp\\locked.tmp", message: "em uso" }],
      errors: []
    })
  }));
  const result = await exec();

  assert.equal(result.overallStatus, "SUCCESS");
  assert.equal(result.steps[0].status, "SUCCESS");
  assert.equal(result.steps[0].blockedCount, 1);
  assert.match(result.steps[0].message, /ignorados/);
});

test("system_maintenance continua após falha do SFC e marca resultado global", async () => {
  const calls = [];
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    runSfc: async () => { calls.push("sfc"); return { exitCode: 1, durationMs: 10, stdout: "", stderr: "falhou" }; },
    runDism: async () => { calls.push("dism"); return { exitCode: 0, durationMs: 10, stdout: "", stderr: "" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 10, stdout: "", stderr: "" }; }
  }))();

  assert.equal(result.overallStatus, "FAILED");
  assert.equal(result.steps[1].status, "FAILED");
  assert.deepEqual(calls, ["sfc", "dism", "dns"]);
});

test("system_maintenance registra falha do DISM e continua para DNS", async () => {
  const calls = [];
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    runDism: async () => { calls.push("dism"); return { exitCode: 2, durationMs: 10, stdout: "", stderr: "falhou" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 10, stdout: "", stderr: "" }; }
  }))();

  assert.equal(result.overallStatus, "FAILED");
  assert.equal(result.steps[2].status, "FAILED");
  assert.deepEqual(calls, ["dism", "dns"]);
});

test("system_maintenance registra falha do DNS sem perder as etapas anteriores", async () => {
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    flushDns: async () => ({ exitCode: 1, durationMs: 10, stdout: "", stderr: "falhou" })
  }))();

  assert.equal(result.overallStatus, "FAILED");
  assert.equal(result.steps[3].key, "dns_flush");
  assert.equal(result.steps[3].status, "FAILED");
});

test("system_maintenance aplica timeout próprio ao SFC", async () => {
  const exec = createSystemMaintenanceExecutor({
    timeouts: { tempCleanupMs: 100, sfcMs: 20, dismMs: 100, dnsFlushMs: 100 },
    cleanupTemp: async () => ({ roots: [], blocked: [], errors: [] }),
    runCommand: async (file) => file === "sfc.exe" ? new Promise(() => {}) : { exitCode: 0, stdout: "", stderr: "" }
  });
  const result = await exec();

  assert.equal(result.steps[1].status, "FAILED");
  assert.match(result.steps[1].message, /tempo limite/);
});

test("system_maintenance aplica timeout próprio ao DISM", async () => {
  const exec = createSystemMaintenanceExecutor({
    timeouts: { tempCleanupMs: 100, sfcMs: 100, dismMs: 20, dnsFlushMs: 100 },
    cleanupTemp: async () => ({ roots: [], blocked: [], errors: [] }),
    runCommand: async (file) => file === "dism.exe" ? new Promise(() => {}) : { exitCode: 0, stdout: "", stderr: "" }
  });
  const result = await exec();

  assert.equal(result.steps[2].status, "FAILED");
  assert.match(result.steps[2].message, /tempo limite/);
});

test("system_maintenance rejeita concorrência e mantém dedup por actionExecutionId", async () => {
  let release;
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    executeSystemMaintenance: async () => {
      runs += 1;
      await new Promise((resolve) => { release = resolve; });
      return { overallStatus: "SUCCESS", steps: [], notification: { status: "SKIPPED" }, rebootRecommended: true };
    }
  });
  const firstPromise = runtime.handleRemoteAction(makeWs(), { actionExecutionId: "maintenance-1", action: "system_maintenance" });
  await new Promise((resolve) => setImmediate(resolve));
  const concurrent = await runtime.handleRemoteAction(makeWs(), { actionExecutionId: "maintenance-2", action: "system_maintenance" });
  assert.equal(concurrent.status, "REJECTED");
  release();
  const first = await firstPromise;
  const duplicate = await runtime.handleRemoteAction(makeWs(), { actionExecutionId: "maintenance-1", action: "system_maintenance" });
  assert.equal(first.status, "SUCCESS");
  assert.equal(duplicate.status, "SUCCESS");
  assert.equal(runs, 1);
});

test("system_maintenance nao falha globalmente se o Notifier estiver indisponivel", async () => {
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    notifyUser: async () => ({ ok: false, message: "Notifier indisponível." })
  }))();

  assert.equal(result.overallStatus, "SUCCESS");
  assert.equal(result.notification.status, "SKIPPED");
  assert.match(result.notification.message, /Notifier/);
});
