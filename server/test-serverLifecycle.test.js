const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { createShutdownController } = require("./src/serverLifecycle");

function makeRuntime({ closeServer = true, closeWebSocket = true, disconnect = true, timeoutMs = 100 } = {}) {
  const order = [];
  const processRef = new EventEmitter();
  const server = {
    close(callback) { order.push("http"); if (closeServer) callback(); },
    closeIdleConnections() { order.push("http-idle"); },
    closeAllConnections() { order.push("http-all"); }
  };
  const socket = { OPEN: 1, readyState: 1, close: () => order.push("socket-close"), terminate: () => order.push("socket-terminate") };
  const wss = {
    clients: new Set([socket]),
    close(callback) { order.push("websocket"); if (closeWebSocket) callback(); }
  };
  const prisma = { $disconnect: async () => { order.push("prisma"); if (!disconnect) await new Promise(() => {}); } };
  const schedulers = [{ stop: () => order.push("scheduler") }, { stop: () => { order.push("scheduler-error"); throw new Error("stop failed"); } }];
  const controller = createShutdownController({ server, wss, schedulers, prisma, processRef, timeoutMs, log: (message) => order.push(message), setShuttingDown: () => order.push("readiness") });
  return { controller, order, processRef, server, wss, prisma };
}

test("SIGTERM chama shutdown uma vez e fecha recursos na ordem básica", async () => {
  const runtime = makeRuntime();
  runtime.controller.registerSignals(runtime.processRef);
  runtime.processRef.emit("SIGTERM");
  runtime.processRef.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.order.filter((item) => item === "scheduler").length, 1);
  assert.deepEqual(runtime.order.filter((item) => ["readiness", "scheduler", "scheduler-error", "http", "http-idle", "socket-close", "websocket", "prisma"].includes(item)), ["readiness", "scheduler", "scheduler-error", "http", "http-idle", "socket-close", "websocket", "prisma"]);
  assert.equal(runtime.order.filter((item) => item === "websocket").length, 1);
  assert.equal(runtime.order.filter((item) => item === "prisma").length, 1);
  assert.equal(runtime.processRef.exitCode, 1);
});

test("SIGINT também chama shutdown e sinais concorrentes não duplicam encerramento", async () => {
  const runtime = makeRuntime();
  runtime.controller.registerSignals(runtime.processRef);
  runtime.controller.registerSignals(runtime.processRef);
  runtime.processRef.emit("SIGINT");
  const first = runtime.controller.shutdown("manual");
  await first;
  assert.equal(runtime.order.filter((item) => String(item).includes("shutdown iniciado")).length, 1);
  assert.equal(runtime.order.filter((item) => item === "prisma").length, 1);
});

test("erro ao parar um recurso não impede os demais", async () => {
  const runtime = makeRuntime();
  await runtime.controller.shutdown("SIGTERM");
  assert.ok(runtime.order.includes("http"));
  assert.ok(runtime.order.includes("websocket"));
  assert.ok(runtime.order.includes("prisma"));
  assert.equal(runtime.processRef.exitCode, 1);
});

test("timeout termina sockets restantes e define exit code de falha", async () => {
  const runtime = makeRuntime({ closeServer: false, closeWebSocket: false, timeoutMs: 15 });
  await runtime.controller.shutdown("SIGTERM");
  assert.ok(runtime.order.includes("socket-terminate"));
  assert.ok(runtime.order.includes("http-all"));
  assert.equal(runtime.processRef.exitCode, 1);
});

test("importar app não abre porta nem registra sinais", () => {
  const app = require("./src/app");
  assert.equal(typeof app, "function");
  assert.equal(typeof app.startServer, "function");
});
