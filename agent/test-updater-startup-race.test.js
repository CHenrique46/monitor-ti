const test = require("node:test");
const assert = require("node:assert/strict");
const { waitForServiceRunning, SERVICE_START_TIMEOUT_MS } = require("./src/updater");

function clocked(states, { intervalMs = 1000, timeoutMs = SERVICE_START_TIMEOUT_MS } = {}) {
  let time = 0;
  let index = 0;
  const probes = [];
  const result = waitForServiceRunning("MonitorTIAgent", {
    timeoutMs,
    pollIntervalMs: intervalMs,
    now: () => time,
    sleepImpl: (ms) => { time += ms; },
    getInfo: () => {
      const state = states[Math.min(index++, states.length - 1)];
      if (state === "ERROR") throw new Error("transient CIM failure");
      return state ? { state, processId: state === "Running" ? 17132 : 0 } : null;
    },
    onProbe: (probe) => probes.push(probe)
  });
  return { result, probes };
}

test("serviço inicia imediatamente", () => {
  const { result } = clocked(["Running"]);
  assert.equal(result.running, true);
  assert.equal(result.attempts, 1);
});

test("StartPending evolui para Running", () => {
  const { result } = clocked(["StartPending", "StartPending", "Running"]);
  assert.equal(result.running, true);
  assert.equal(result.attempts, 3);
});

test("CIM vazio/erro transitório evolui para Running", () => {
  const { result } = clocked([null, "ERROR", "Running"]);
  assert.equal(result.running, true);
  assert.equal(result.attempts, 3);
});

test("serviço demora, mas inicia dentro do timeout", () => {
  const { result } = clocked(["StartPending", "StartPending", "StartPending", "Running"], { intervalMs: 500 });
  assert.equal(result.running, true);
  assert.equal(result.elapsedMs, 1500);
});

test("serviço nunca inicia e gera uma única falha", () => {
  const { result, probes } = clocked(["StartPending"], { intervalMs: 1000, timeoutMs: 3000 });
  assert.equal(result.running, false);
  assert.equal(result.attempts, 4);
  assert.equal(probes.length, 4);
});

test("resultado terminal permanece único", () => {
  const { result } = clocked(["StartPending", "Running"]);
  const terminal = result.running ? ["SUCCESS"] : ["FAILURE"];
  assert.deepEqual(terminal, ["SUCCESS"]);
  assert.equal(terminal.includes("FAILURE"), false);
});

test("falha real não vira sucesso tardio", () => {
  const { result } = clocked(["Stopped"], { intervalMs: 1000, timeoutMs: 1000 });
  const terminal = result.running ? ["SUCCESS"] : ["FAILURE"];
  assert.deepEqual(terminal, ["FAILURE"]);
});

test("timestamps de polling são correlacionáveis", () => {
  const { probes } = clocked(["StartPending", "Running"]);
  assert.equal(probes.every((probe) => Number.isInteger(probe.elapsedMs)), true);
  assert.equal(probes[0].attempts, 1);
  assert.equal(probes[1].attempts, 2);
});
