const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const { DEFAULTS, createConnectionLifecycle } = require("./src/connectionLifecycle");

class Clock {
  constructor() { this.time = 0; this.nextId = 1; this.timers = new Map(); }
  setTimeout = (fn, delay) => { const id = this.nextId++; this.timers.set(id, { fn, due: this.time + delay, interval: 0 }); return id; };
  clearTimeout = (id) => { this.timers.delete(id); };
  setInterval = (fn, interval) => { const id = this.nextId++; this.timers.set(id, { fn, due: this.time + interval, interval }); return id; };
  clearInterval = this.clearTimeout;
  now = () => this.time;
  advance(ms) {
    const end = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      this.time = next[1].due;
      const [id, timer] = next;
      if (timer.interval) timer.due += timer.interval;
      else this.timers.delete(id);
      timer.fn();
    }
    this.time = end;
  }
}

class FakeSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 0; this.sent = []; this.pings = 0; }
  send(message) { this.sent.push(JSON.parse(message)); }
  ping() { this.pings += 1; }
  terminate() { this.readyState = 3; this.emit("close"); }
  close() { this.readyState = 2; this.emit("close"); }
}

function setup(overrides = {}) {
  const clock = new Clock();
  const sockets = [];
  class FakeWebSocket extends FakeSocket {
    constructor(url) { super(url); sockets.push(this); }
  }
  FakeWebSocket.OPEN = 1;
  const scheduled = [];
  const lifecycle = createConnectionLifecycle({
    WebSocket: FakeWebSocket,
    serverUrl: "ws://test",
    now: clock.now,
    random: () => 0.5,
    timers: clock,
    options: { livenessCheckMs: 1000, ...overrides },
    onReconnectScheduled: (delay) => scheduled.push(delay)
  });
  return { clock, sockets, scheduled, lifecycle };
}

test("fecha handshake pendente e agenda uma única reconexão com backoff", () => {
  const { clock, sockets, scheduled, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  clock.advance(DEFAULTS.handshakeTimeoutMs);
  assert.equal(sockets[0].readyState, 3);
  assert.deepEqual(scheduled, [5000]);
  assert.equal(lifecycle.getState().reconnectScheduled, true);
  clock.advance(5000);
  assert.equal(sockets.length, 2);
  assert.equal(lifecycle.getState().active, true);
});

test("fecha conexão aberta sem confirmação de registro", () => {
  const { clock, sockets, scheduled, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  sockets[0].readyState = 1;
  sockets[0].emit("open");
  clock.advance(DEFAULTS.registerTimeoutMs);
  assert.equal(sockets[0].readyState, 3);
  assert.equal(scheduled.length, 1);
});

test("aceita a solicitação de reconciliação legada como confirmação do registro", () => {
  const { clock, sockets, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  sockets[0].readyState = 1;
  sockets[0].emit("open");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "remote_action_reconcile_request", deviceId: "device-1" })));
  clock.advance(DEFAULTS.registerTimeoutMs);
  assert.equal(sockets[0].readyState, 1);
  assert.equal(lifecycle.getState().reconnectAttempt, 0);
});

test("pong mantém a conexão e ausência de pong causa nova tentativa", () => {
  const { clock, sockets, scheduled, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  sockets[0].readyState = 1;
  sockets[0].emit("open");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "register_ack", deviceId: "device-1" })));
  clock.advance(DEFAULTS.pingIntervalMs);
  assert.equal(sockets[0].pings, 1);
  sockets[0].emit("pong");
  clock.advance(DEFAULTS.livenessTimeoutMs);
  assert.equal(sockets[0].readyState, 1);
  clock.advance(1001);
  assert.equal(scheduled.length, 1);
});

test("eventos atrasados do socket antigo não afetam o socket novo", () => {
  const { clock, sockets, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  sockets[0].readyState = 1;
  sockets[0].emit("open");
  sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "register_ack", deviceId: "device-1" })));
  sockets[0].emit("close");
  clock.advance(5000);
  assert.equal(sockets.length, 2);
  sockets[1].readyState = 1;
  sockets[1].emit("open");
  sockets[0].emit("close");
  assert.equal(lifecycle.getState().active, true);
});

test("shutdown intencional cancela timers e não reconecta", () => {
  const { clock, sockets, scheduled, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  lifecycle.stop();
  clock.advance(DEFAULTS.handshakeTimeoutMs + DEFAULTS.reconnectBackoffMs[0]);
  assert.equal(sockets.length, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(lifecycle.getState().stopping, true);
});

test("backoff cresce até 30 segundos e mantém jitter limitado", () => {
  const { clock, sockets, scheduled, lifecycle } = setup();
  lifecycle.connect({ deviceId: "device-1" });
  for (const expected of [5000, 10000, 20000, 30000, 30000]) {
    sockets[sockets.length - 1].terminate();
    assert.equal(scheduled.at(-1), expected);
    clock.advance(expected);
    if (sockets.length < 6) sockets[sockets.length - 1].terminate();
  }
  assert.equal(Math.max(...scheduled), 30000);
});
