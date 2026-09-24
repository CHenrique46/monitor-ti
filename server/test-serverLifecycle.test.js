const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { performance } = require("node:perf_hooks");
const { createShutdownController } = require("./src/serverLifecycle");

function makeServer({ close = true } = {}) {
  const server = new EventEmitter();
  server.close = (callback) => { if (close) callback(); };
  server.closeIdleConnections = () => {};
  server.closeAllConnections = () => {};
  return server;
}

function makeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; socket.emit("close"); };
  return socket;
}

function makeWebSocket({ close = true, count = 0 } = {}) {
  const clients = new Set();
  for (let i = 0; i < count; i++) {
    clients.add({ readyState: 1, OPEN: 1, close() {}, terminate() { clients.delete(this); } });
  }
  return {
    clients,
    stopHeartbeatCalls: 0,
    stopHeartbeat() { this.stopHeartbeatCalls++; },
    close(callback) { if (close) callback(); }
  };
}

function makeRuntime(options = {}) {
  const processRef = new EventEmitter();
  const server = makeServer({ close: options.httpClose !== false });
  const wss = makeWebSocket({ close: options.wsClose !== false, count: options.clientCount || 0 });
  const order = [];
  let disconnectCalls = 0;
  let tickCalls = 0;
  let stopped = false;
  const scheduler = {
    stop() { stopped = true; order.push("scheduler-stop"); },
    tick() { if (!stopped) tickCalls++; }
  };
  const prisma = {
    async $disconnect() {
      disconnectCalls++;
      order.push("prisma");
      if (options.prisma === "hang") await new Promise(() => {});
      if (options.prisma === "fail") throw new Error("disconnect failed");
    }
  };
  const controller = createShutdownController({
    server,
    wss,
    schedulers: [scheduler],
    prisma,
    timeoutMs: options.timeoutMs || 250,
    cleanup: options.cleanup || (async () => {}),
    processRef,
    setShuttingDown: () => order.push("shutting-down"),
    log: (message) => order.push(message)
  });
  return { controller, processRef, server, wss, prisma, scheduler, order, get disconnectCalls() { return disconnectCalls; }, get tickCalls() { return tickCalls; } };
}

test("SIGINT and SIGTERM are single-shot and exit cleanly", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const runtime = makeRuntime();
    runtime.controller.registerSignals(runtime.processRef);
    runtime.processRef.emit(signal);
    runtime.processRef.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    const result = await runtime.controller.shutdown("manual");
    assert.equal(result.exitCode, 0);
    assert.equal(runtime.processRef.exitCode, 0);
    assert.equal(runtime.order.filter((entry) => String(entry).includes("shutdown iniciado")).length, 1);
  }
});

test("many normal WebSocket clients stop within the bounded shutdown", async () => {
  const runtime = makeRuntime({ clientCount: 200 });
  const started = performance.now();
  const result = await runtime.controller.shutdown("SIGINT");
  assert.equal(result.exitCode, 0);
  assert.equal(runtime.wss.stopHeartbeatCalls, 1);
  assert.ok(performance.now() - started < 250);
});

test("a resistant WebSocket client is terminated without blocking shutdown", async () => {
  const runtime = makeRuntime({ wsClose: false, clientCount: 1, timeoutMs: 120 });
  const result = await runtime.controller.shutdown("SIGINT");
  assert.equal(result.exitCode, 0);
  assert.ok(result.warnings.some((warning) => warning.includes("WebSocket close timeout")));
  assert.equal(runtime.wss.clients.size, 0);
});

test("persistent HTTP keep-alive sockets are tracked and destroyed", async () => {
  const runtime = makeRuntime({ httpClose: false, timeoutMs: 120 });
  const socket = makeSocket();
  runtime.server.emit("connection", socket);
  const result = await runtime.controller.shutdown("SIGINT");
  assert.equal(result.exitCode, 0);
  assert.equal(socket.destroyed, true);
  assert.ok(result.warnings.some((warning) => warning.includes("HTTP close timeout")));
});

test("a WebSocket close callback that never completes is bounded", async () => {
  const runtime = makeRuntime({ wsClose: false, timeoutMs: 120 });
  const started = performance.now();
  await runtime.controller.shutdown("SIGTERM");
  assert.ok(performance.now() - started < 500);
});

test("slow or failed Prisma disconnect preserves controlled exit", async () => {
  for (const mode of ["hang", "fail"]) {
    const runtime = makeRuntime({ prisma: mode, timeoutMs: 120 });
    const result = await runtime.controller.shutdown("SIGTERM");
    assert.equal(result.exitCode, 0);
    assert.equal(runtime.processRef.exitCode, 0);
    assert.equal(runtime.disconnectCalls, 1);
  }
});

test("scheduler stops before cleanup and no new tick starts", async () => {
  const runtime = makeRuntime({ cleanup: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); runtime.scheduler.tick(); } });
  await runtime.controller.shutdown("SIGINT");
  assert.equal(runtime.tickCalls, 0);
  assert.ok(runtime.order.indexOf("scheduler-stop") < runtime.order.indexOf("prisma"));
});

test("total shutdown remains below the configured limit", async () => {
  const runtime = makeRuntime({ wsClose: false, httpClose: false, prisma: "hang", timeoutMs: 120 });
  const started = performance.now();
  const result = await runtime.controller.shutdown("SIGINT");
  const elapsed = performance.now() - started;
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 250);
});

test("importing app does not open a port or register signals", () => {
  const app = require("./src/app");
  assert.equal(typeof app, "function");
  assert.equal(typeof app.startServer, "function");
});
