const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createRemoteActionStore } = require("./src/remoteActionStore");
const { createRemoteActionRuntime } = require("./src/remoteActions");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mti-remote-actions-"));
}

function record(id, status, updatedAt = new Date().toISOString(), extra = {}) {
  return {
    actionExecutionId: id,
    action: "system_maintenance",
    status,
    message: status,
    error: status === "FAILED" ? "falha simulada" : null,
    result: status === "RUNNING" ? null : { id },
    startedAt: updatedAt,
    finishedAt: status === "RUNNING" ? null : updatedAt,
    updatedAt,
    ...extra
  };
}

test("storage persiste RUNNING/terminal e sobrevive a nova instância", () => {
  const dir = tempDir();
  const first = createRemoteActionStore({ dir });
  assert.equal(first.upsert(record("running-1", "RUNNING")), true);
  assert.equal(first.upsert(record("success-1", "SUCCESS")), true);

  const second = createRemoteActionStore({ dir });
  assert.equal(second.get("running-1").status, "RUNNING");
  assert.deepEqual(second.get("success-1").result, { id: "success-1" });
  assert.equal(second.get("success-1").confirmedByServer, false);
});

test("dedup nao reexecuta e terminal duplicado reenvia o resultado salvo", async () => {
  const dir = tempDir();
  const store = createRemoteActionStore({ dir });
  let runs = 0;
  const runtime = createRemoteActionRuntime({
    store,
    getDeviceId: () => "dev-1",
    executeSystemMaintenance: async () => {
      assert.equal(store.get("dup-1").status, "RUNNING");
      runs += 1;
      return { overallStatus: "SUCCESS", steps: [], notification: { status: "SKIPPED" } };
    }
  });
  const ws = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
  await runtime.handleRemoteAction(ws, { actionExecutionId: "dup-1", action: "system_maintenance" });
  const restartedRuntime = createRemoteActionRuntime({
    store,
    executeSystemMaintenance: async () => { throw new Error("não deveria executar"); }
  });
  await restartedRuntime.handleRemoteAction(ws, { actionExecutionId: "dup-1", action: "system_maintenance" });

  assert.equal(runs, 1);
  assert.equal(ws.sent.at(-1).status, "SUCCESS");
  assert.equal(ws.sent.at(-1).result.overallStatus, "SUCCESS");
});

test("storage persiste FAILED e REJECTED sem executar novamente", async () => {
  const dir = tempDir();
  const store = createRemoteActionStore({ dir });
  const runtime = createRemoteActionRuntime({
    store,
    executeSpoolerReset: async () => { throw new Error("spooler falhou"); }
  });
  const ws = { readyState: 1, send() {} };

  await runtime.handleRemoteAction(ws, { actionExecutionId: "failed-1", action: "spooler_reset" });
  await runtime.handleRemoteAction(ws, { actionExecutionId: "rejected-1", action: "acao-invalida" });

  assert.equal(store.get("failed-1").status, "FAILED");
  assert.equal(store.get("rejected-1").status, "REJECTED");
});

test("JSON corrompido e isolado e storage inicia vazio", () => {
  const dir = tempDir();
  const file = path.join(dir, "remote-actions-state.json");
  fs.writeFileSync(file, "{corrompido", "utf8");
  const logs = [];
  const store = createRemoteActionStore({ dir, logEvent: (message) => logs.push(message) });

  assert.equal(store.size, 0);
  assert.equal(logs.length, 1);
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("remote-actions-state.json.corrupt-")), true);
});

test("retencao mantém somente os ultimos registros e escrita nao deixa temporario", () => {
  const dir = tempDir();
  const store = createRemoteActionStore({ dir, maxRecords: 3 });
  for (let i = 0; i < 5; i += 1) {
    store.upsert(record(`ret-${i}`, "SUCCESS", `2026-01-01T00:00:0${i}.000Z`));
  }

  assert.equal(store.size, 3);
  assert.equal(store.get("ret-0"), null);
  assert.deepEqual(store.reconciliationRecords().map((item) => item.actionExecutionId), ["ret-4", "ret-3", "ret-2"]);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-") || name.includes(".replace-")), false);
});

test("reconciliacao inclui RUNNING e terminais nao confirmados, ACK confirma terminal", () => {
  const dir = tempDir();
  const store = createRemoteActionStore({ dir });
  store.upsert(record("running", "RUNNING"));
  store.upsert(record("terminal", "FAILED"));
  store.upsert(record("confirmed", "SUCCESS", new Date().toISOString(), { confirmedByServer: true }));

  assert.deepEqual(store.reconciliationRecords().map((item) => item.actionExecutionId).sort(), ["running", "terminal"]);
  assert.equal(store.markConfirmed("terminal", "FAILED"), true);
  assert.deepEqual(store.reconciliationRecords().map((item) => item.actionExecutionId), ["running"]);
});
