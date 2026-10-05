const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createRemoteActionRuntime,
  createSpoolerResetExecutor,
  createServiceRestartExecutor,
  createSystemMaintenanceExecutor,
  limitSystemMaintenanceResult,
  MAX_MAINTENANCE_RESULT_BYTES
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

test("disk_cleanup_analyze é allowlisted, read-only e retorna análise", async () => {
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    analyzeDiskCleanup: async () => {
      runs += 1;
      return { analysisOnly: true, estimatedRecoverableBytes: 12, actualFreedBytes: null };
    },
    getDeviceId: () => "dev-disk"
  });
  const state = await runtime.handleRemoteAction(makeWs(), { actionExecutionId: "disk-1", action: "DISK_CLEANUP_ANALYZE", payload: { path: "C:\\" } });
  assert.equal(runs, 1);
  assert.equal(state.status, "SUCCESS");
  assert.equal(state.result.analysisOnly, true);
  assert.equal(state.result.actualFreedBytes, null);
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
  assert.equal(result.notification.attempts, 1);
});

test("system_maintenance aguarda limpeza lenta antes da próxima etapa", async () => {
  const calls = [];
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    timeouts: { tempCleanupMs: 1 },
    cleanupTemp: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("cleanup");
      return { roots: [], blocked: [], errors: [] };
    },
    runSfc: async () => { calls.push("sfc"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; }
  }))();

  assert.deepEqual(calls.slice(0, 2), ["cleanup", "sfc"]);
  assert.equal(result.steps[0].timedOut, true);
  assert.equal(result.steps[0].status, "FAILED");
  assert.equal(result.overallStatus, "FAILED");
});

test("system_maintenance continua após bloquear cleanup sem remoção segura", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-maintenance-blocked-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const users = path.join(root, "Users");
  const windows = path.join(root, "Windows", "Temp");
  const temp = path.join(root, "ConfiguredTemp");
  await fs.promises.mkdir(path.join(users, "alice", "AppData", "Local", "Temp"), { recursive: true });
  await fs.promises.mkdir(windows, { recursive: true });
  await fs.promises.mkdir(temp, { recursive: true });
  const target = path.join(temp, "eligible.tmp");
  const now = Date.now();
  await fs.promises.writeFile(target, Buffer.alloc(16));
  await fs.promises.utimes(target, new Date(now - 8 * 86400000), new Date(now - 8 * 86400000));
  const calls = [];
  const result = await createSystemMaintenanceExecutor({
    systemDrive: root,
    usersDir: users,
    windowsDir: path.join(root, "Windows"),
    environment: { TMP: temp },
    registryDiscovery: false,
    now: () => now,
    runSfc: async () => { calls.push("sfc"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    runDism: async () => { calls.push("dism"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    notifyUser: async () => ({ ok: true })
  })();
  assert.deepEqual(calls, ["sfc", "dism", "dns"]);
  assert.equal(result.steps[0].executionBlocked, true);
  assert.equal(result.steps[0].status, "FAILED");
  assert.equal(result.steps[0].details.actualFreedBytes, null);
  assert.equal(result.steps[0].details.deletedBytes, null);
  assert.equal(result.overallStatus, "FAILED");
  assert.equal(fs.existsSync(target), true);
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

test("system_maintenance limita listas de bloqueados e erros com contadores totais", async () => {
  const blocked = Array.from({ length: 75 }, (_, i) => ({ path: `locked-${i}`, message: "em uso" }));
  const errors = Array.from({ length: 63 }, (_, i) => ({ path: `error-${i}`, message: "acesso negado" }));
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    cleanupTemp: async () => ({ roots: [], blocked, errors })
  }))();
  const details = result.steps[0].details;

  assert.equal(result.steps[0].blockedCount, 75);
  assert.equal(result.steps[0].errorsCount, 63);
  assert.equal(details.blocked.length, 50);
  assert.equal(details.errors.length, 50);
  assert.equal(result.steps[0].truncated, true);
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

test("system_maintenance repete somente a notificacao quando o Notifier esta BUSY", async () => {
  const calls = [];
  let notifications = 0;
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    cleanupTemp: async () => { calls.push("cleanup"); return { roots: [], blocked: [], errors: [] }; },
    runSfc: async () => { calls.push("sfc"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    runDism: async () => { calls.push("dism"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    notifyUser: async () => (++notifications === 1 ? { ok: false, reason: "BUSY", message: "ocupado" } : { ok: true }),
    sleep: async (delayMs) => assert.equal(delayMs, 30000)
  }))();

  assert.equal(result.overallStatus, "SUCCESS");
  assert.deepEqual(calls, ["cleanup", "sfc", "dism", "dns"]);
  assert.equal(result.notification.status, "SUCCESS");
  assert.equal(result.notification.attempts, 2);
  assert.equal(result.notification.initialReason, "BUSY");
  assert.equal(result.notification.delivered, true);
});

test("system_maintenance limita retries BUSY sem repetir etapas tecnicas", async () => {
  const calls = [];
  let notifications = 0;
  const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
    cleanupTemp: async () => { calls.push("cleanup"); return { roots: [], blocked: [], errors: [] }; },
    runSfc: async () => { calls.push("sfc"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    runDism: async () => { calls.push("dism"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    flushDns: async () => { calls.push("dns"); return { exitCode: 0, durationMs: 1, stdout: "", stderr: "" }; },
    notifyUser: async () => { notifications += 1; return { ok: false, reason: "BUSY", message: "ocupado" }; },
    sleep: async () => {}
  }))();

  assert.equal(result.overallStatus, "SUCCESS");
  assert.deepEqual(calls, ["cleanup", "sfc", "dism", "dns"]);
  assert.equal(notifications, 5);
  assert.equal(result.notification.status, "SKIPPED");
  assert.equal(result.notification.attempts, 5);
  assert.equal(result.notification.initialReason, "BUSY");
  assert.match(result.notification.message, /5 tentativas/);
});

test("system_maintenance nao repete para Notifier indisponivel ou erro inesperado", async () => {
  for (const notified of [
    { ok: false, reason: "NOTIFIER_NOT_READY", message: "indisponivel" },
    new Error("falha inesperada")
  ]) {
    let notifications = 0;
    const result = await createSystemMaintenanceExecutor(maintenanceSuccessDeps({
      notifyUser: async () => {
        notifications += 1;
        if (notified instanceof Error) throw notified;
        return notified;
      },
      sleep: async () => { throw new Error("nao deveria aguardar"); }
    }))();
    assert.equal(notifications, 1);
    assert.equal(result.overallStatus, "SUCCESS");
    assert.equal(result.notification.status, "SKIPPED");
    assert.equal(result.notification.attempts, 1);
  }
});

test("system_maintenance marca result.truncated e preserva etapas quando resultado excede o limite", () => {
  const result = limitSystemMaintenanceResult({
    overallStatus: "FAILED",
    steps: [{
      key: "sfc",
      status: "FAILED",
      durationMs: 100,
      message: "falhou",
      output: { stdout: "x".repeat(MAX_MAINTENANCE_RESULT_BYTES) },
      details: { blocked: [], errors: [] }
    }],
    notification: { status: "SKIPPED", message: "indisponível" },
    rebootRecommended: true
  });

  assert.equal(result.truncated, true);
  assert.equal(result.overallStatus, "FAILED");
  assert.equal(result.steps[0].status, "FAILED");
  assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") <= MAX_MAINTENANCE_RESULT_BYTES, true);
});
