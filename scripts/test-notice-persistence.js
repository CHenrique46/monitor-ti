const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const { createNoticeRuntime } = require("../agent/src/notices/runtime");
const { loadNoticeState, saveNoticeState, pruneState, emptyState, getStatePath } = require("../agent/src/notices/persistence");
const { version: AGENT_VERSION } = require("../agent/package.json");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function createClient(pipePath) {
  const socket = net.createConnection(pipePath);
  socket.setEncoding("utf8");
  let buffer = "";
  const queue = [];
  const waiters = [];

  function flush() {
    while (queue.length && waiters.length) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(queue.shift());
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line) queue.push(line);
    }
    flush();
  });

  return {
    socket,
    waitConnect() {
      return new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },
    send(obj) {
      socket.write(JSON.stringify(obj) + "\n");
    },
    nextLine(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout aguardando linha")), timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
    close() {
      try { socket.end(); } catch {}
    }
  };
}

async function connectClient(pipePath) {
  for (let i = 0; i < 50; i++) {
    const client = createClient(pipePath);
    try {
      await client.waitConnect();
      return client;
    } catch (err) {
      client.close();
      await wait(100);
    }
  }
  throw new Error("nao foi possivel conectar ao pipe");
}

function makeRuntime(configDir, pipeName) {
  const events = [];
  const serverEvents = [];
  const runtime = createNoticeRuntime({
    configDir,
    getDeviceId: () => "device-persist",
    getAppDir: () => configDir,
    logEvent: (m) => events.push(m),
    version: AGENT_VERSION,
    getInteractiveUser: () => "Henrique",
    pipeName,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 250,
    processInfoLookup: () => ({ exists: true, sessionId: 1, domain: "", user: "Henrique", path: "C:\\Test\\companion.exe" }),
    onServerEvent: (m) => serverEvents.push(m)
  });
  runtime.start();
  return { runtime, events, serverEvents, pipePath: "\\\\.\\pipe\\" + pipeName };
}

async function main() {
  const dir = tempDir("mti-persist-");
  const pipe = "MTI-PERSIST-" + uuid();
  const statePath = getStatePath(dir);

  // PERSIST-005 escrita atomica.
  saveNoticeState(dir, emptyState());
  check("PERSIST-005 arquivo criado", fs.existsSync(statePath));
  check("PERSIST-005 sem tmp residual", !fs.existsSync(statePath + ".tmp"));

  // PERSIST-004 arquivo corrompido é quarantined.
  fs.writeFileSync(statePath, "{ invalid json", "utf8");
  const rCorrupt = makeRuntime(dir, pipe + "-corrupt");
  await wait(150);
  const corruptFiles = fs.readdirSync(path.join(dir, "state")).filter((f) => f.startsWith("notices.corrupt-"));
  check("PERSIST-004 corrompido quarantined", corruptFiles.length >= 1);
  check("PERSIST-004 inicia vazio", rCorrupt.runtime.getState().queueLength === 0);
  rCorrupt.runtime.stop();

  // PERSIST-001 QUEUED sobrevive restart.
  const r1 = makeRuntime(dir, pipe);
  const noticeId = uuid();
  r1.runtime.enqueueFromServer({ noticeDeliveryId: noticeId, title: "Persist", message: "Queue", level: "info", timestamp: new Date().toISOString(), scheduledAt: new Date().toISOString() });
  await wait(200);
  check("PERSIST-007 sem connections persistidas", !Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(statePath, "utf8")), "connections"));
  r1.runtime.stop();

  const saved1 = JSON.parse(fs.readFileSync(statePath, "utf8"));
  check("PERSIST-001 queue salva", Array.isArray(saved1.queue) && saved1.queue.includes(noticeId));
  check("PERSIST-008 dedup salva", saved1.dedup && saved1.dedup[noticeId]);

  const r2 = makeRuntime(dir, pipe);
  const client = await connectClient(r2.pipePath);
  client.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.7", sessionId: 1, pid: 2222, username: "Henrique", activeNoticeDeliveryId: null });
  await client.nextLine();
  client.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 2222, ts: new Date().toISOString() });
  const queuedLine = JSON.parse(await client.nextLine());
  check("PERSIST-001 queue reentregue apos restart", queuedLine.noticeDeliveryId === noticeId);
  client.send({ type: "received", protocolVersion: 1, noticeDeliveryId: noticeId, sessionId: 1, pid: 2222, ts: new Date().toISOString() });
  client.send({ type: "acknowledged", protocolVersion: 1, noticeDeliveryId: noticeId, sessionId: 1, pid: 2222, ts: new Date().toISOString() });
  await wait(150);
  r2.runtime.stop();

  // PERSIST-002 DISPLAYED não reabre e PERSIST-003 ACKNOWLEDGED não reabre.
  const displayedId = uuid();
  const ackId = uuid();
  const state = loadNoticeState(dir);
  state.deliveries[displayedId] = { noticeDeliveryId: displayedId, state: "DISPLAYED", createdAt: Date.now() - 1000, updatedAt: Date.now(), payload: { noticeDeliveryId: displayedId, title: "D", message: "D", level: "info", timestamp: new Date().toISOString() } };
  state.deliveries[ackId] = { noticeDeliveryId: ackId, state: "ACKNOWLEDGED", createdAt: Date.now() - 1000, updatedAt: Date.now(), acknowledgedAt: Date.now() - 500, payload: { noticeDeliveryId: ackId, title: "A", message: "A", level: "info", timestamp: new Date().toISOString() } };
  state.queue = [];
  saveNoticeState(dir, state);

  const r3 = makeRuntime(dir, pipe + "-2");
  const client2 = await connectClient(r3.pipePath);
  client2.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.7", sessionId: 1, pid: 3333, username: "Henrique", activeNoticeDeliveryId: displayedId });
  await client2.nextLine();
  client2.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 3333, ts: new Date().toISOString() });
  let reopened = false;
  try {
    const line = await Promise.race([client2.nextLine(300), wait(300).then(() => null)]);
    reopened = !!line;
  } catch {
    reopened = false;
  }
  check("PERSIST-002 DISPLAYED nao reabre", reopened === false);
  client2.close();
  r3.runtime.stop();

  const r4 = makeRuntime(dir, pipe + "-3");
  const client3 = await connectClient(r4.pipePath);
  client3.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.7", sessionId: 1, pid: 4444, username: "Henrique", activeNoticeDeliveryId: ackId });
  await client3.nextLine();
  client3.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 4444, ts: new Date().toISOString() });
  let reopenedAck = false;
  try {
    const line = await Promise.race([client3.nextLine(300), wait(300).then(() => null)]);
    reopenedAck = !!line;
  } catch {
    reopenedAck = false;
  }
  check("PERSIST-003 ACKNOWLEDGED nao reabre", reopenedAck === false);
  client3.close();
  r4.runtime.stop();

  // PERSIST-006 retenção 24h.
  const expired = pruneState({
    version: 1,
    deliveries: {
      old: { noticeDeliveryId: "old", state: "ACKNOWLEDGED", createdAt: Date.now() - (25 * 60 * 60 * 1000), updatedAt: Date.now() - (25 * 60 * 60 * 1000) }
    },
    queue: ["old"],
    dedup: {
      old: { state: "ACKNOWLEDGED", updatedAt: Date.now() - (25 * 60 * 60 * 1000) }
    },
    updatedAt: new Date().toISOString()
  });
  check("PERSIST-006 retenção 24h", !expired.deliveries.old && !expired.dedup.old);

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
