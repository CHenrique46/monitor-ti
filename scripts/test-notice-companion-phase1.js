const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  PROTOCOL_VERSION,
  MAX_MESSAGE_BYTES,
  parseJsonLine,
  validateRegister,
  validateNoticeShow,
  serializeMessage
} = require("../agent/src/notices/protocol");
const {
  NOTIFIER_STATES,
  DELIVERY_STATES,
  nextNotifierState,
  nextDeliveryState,
  hasNoticesCapability,
  selectNotifier
} = require("../agent/src/notices/state");
const { createNoticeRuntime } = require("../agent/src/notices/runtime");
const { validateSpec, buildInstallCommand, buildRemoveCommand } = require("./notifier-companion-task");
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

function pipePath(name) {
  return "\\\\.\\pipe\\" + name;
}

function processInfoLookup(sessionId, username) {
  return (pid) => ({
    exists: true,
    sessionId,
    domain: "TEST",
    user: username,
    path: "C:\\Test\\companion.exe",
    pid
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(pathName) {
  const socket = net.createConnection(pathName);
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
    async waitConnect() {
      await new Promise((resolve, reject) => {
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

async function connectClient(pathName) {
  for (let i = 0; i < 50; i++) {
    const client = createClient(pathName);
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

function startRuntime(opts = {}) {
  const configDir = tempDir("mti-phase1-");
  const sessionId = 7;
  const username = "Alice";
  const name = "MonitorTI-Phase1-" + uuid();
  const runtimeEvents = [];
  const serverEvents = [];
  const runtime = createNoticeRuntime({
    configDir,
    getDeviceId: () => "device-test",
    getAppDir: () => configDir,
    logEvent: (m) => runtimeEvents.push(m),
    version: AGENT_VERSION,
    getInteractiveUser: () => username,
    pipeName: name,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 250,
    processInfoLookup: processInfoLookup(sessionId, username),
    onServerEvent: (m) => serverEvents.push(m),
    ...opts
  });
  runtime.start();
  return { runtime, runtimeEvents, serverEvents, sessionId, username, name, path: pipePath(name), configDir };
}

async function run() {
  // Pure unit checks.
  check("PIPE-002 protocol mismatch", validateRegister({ type: "register", protocolVersion: 2, notifierVersion: "1.1.7", sessionId: 7, pid: 1, username: "Alice", activeNoticeDeliveryId: null }).code === "PROTOCOL_MISMATCH");
  check("PIPE-004 JSON parcial", parseJsonLine('{"type":"register"') === null);
  check("PIPE-005 malformed JSON", parseJsonLine('{not-json}') === null);
  check("PIPE-006 mensagem >64KB", (() => {
    try {
      serializeMessage({ type: "x", payload: "a".repeat(MAX_MESSAGE_BYTES) });
      return false;
    } catch (err) {
      return err.message === "MESSAGE_TOO_LARGE";
    }
  })());

  check("STATE-001 DISCONNECTED->REGISTERED", nextNotifierState(NOTIFIER_STATES.DISCONNECTED, "connect") === NOTIFIER_STATES.CONNECTING && nextNotifierState(NOTIFIER_STATES.CONNECTING, "register_ok") === NOTIFIER_STATES.REGISTERED);
  check("STATE-002 REGISTERED->READY", nextNotifierState(NOTIFIER_STATES.REGISTERED, "heartbeat") === NOTIFIER_STATES.READY);
  check("STATE-003 READY->BUSY", nextNotifierState(NOTIFIER_STATES.READY, "notice_show") === NOTIFIER_STATES.BUSY);
  check("STATE-004 BUSY->READY", nextNotifierState(NOTIFIER_STATES.BUSY, "acknowledged") === NOTIFIER_STATES.READY);
  check("STATE-005 heartbeat timeout->STALE", nextNotifierState(NOTIFIER_STATES.READY, "stale") === NOTIFIER_STATES.STALE);

  check("CAP-001 sem notifier=false", hasNoticesCapability([], Date.now(), 1000) === false);
  check("CAP-002 REGISTERED=false", hasNoticesCapability([{ state: NOTIFIER_STATES.REGISTERED, lastHeartbeat: new Date().toISOString(), sessionEligible: true }], Date.now(), 1000) === false);
  check("CAP-003 READY=true", hasNoticesCapability([{ state: NOTIFIER_STATES.READY, lastHeartbeat: new Date().toISOString(), sessionEligible: true }], Date.now(), 1000) === true);
  check("CAP-004 BUSY=true", hasNoticesCapability([{ state: NOTIFIER_STATES.BUSY, lastHeartbeat: new Date().toISOString(), sessionEligible: true }], Date.now(), 1000) === true);
  check("CAP-005 STALE=false", hasNoticesCapability([{ state: NOTIFIER_STATES.BUSY, lastHeartbeat: new Date(Date.now() - 5000).toISOString(), sessionEligible: true }], Date.now(), 1000) === false);
  check("selector prefere READY", (() => {
    const s = selectNotifier([
      { state: NOTIFIER_STATES.BUSY, lastHeartbeat: new Date().toISOString(), sessionEligible: true },
      { state: NOTIFIER_STATES.READY, lastHeartbeat: new Date().toISOString(), sessionEligible: true }
    ]);
    return s && s.state === NOTIFIER_STATES.READY;
  })());

  check("validate notice_show", validateNoticeShow({ type: "notice_show", protocolVersion: PROTOCOL_VERSION, noticeDeliveryId: uuid(), title: "Teste", message: "Mensagem", level: "info", timestamp: new Date().toISOString(), url: "https://exemplo.local" }).ok === true);
  check("TASK static spec", validateSpec({ taskName: "MonitorTI-Notifier", trigger: { type: "AtLogOn", user: null }, principal: { groupId: "S-1-5-11", logonType: "Group", runLevel: "Limited" }, executable: "C:\\Program Files (x86)\\MonitorTI\\Agent\\MonitorTI-Notifier.exe", workingDirectory: "C:\\Program Files (x86)\\MonitorTI\\Agent", arguments: ["--companion"], elevation: "none" }) === true);
  check("TASK install command", /powershell\.exe/.test(buildInstallCommand()) && /-Mode install/.test(buildInstallCommand()));
  check("TASK remove command", /powershell\.exe/.test(buildRemoveCommand()) && /-Mode remove/.test(buildRemoveCommand()));

  // Runtime integration: register, notice, busy, ack, reconnect.
  const rt = startRuntime();
  await wait(100);
  const client = await connectClient(rt.path);
  client.send({ type: "register", protocolVersion: PROTOCOL_VERSION, notifierVersion: AGENT_VERSION, sessionId: rt.sessionId, pid: 1234, username: rt.username, activeNoticeDeliveryId: null });
  const registerOk = JSON.parse(await client.nextLine());
  check("PIPE-001 register válido", registerOk.type === "register_ok" && registerOk.protocolVersion === PROTOCOL_VERSION);
  client.send({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  await wait(50);
  check("STATE-002 REGISTERED->READY", rt.runtime.getState().connections[0] && rt.runtime.getState().connections[0].state === NOTIFIER_STATES.READY);

  const noticeId = uuid();
  const ok = rt.runtime.enqueueFromServer({
    noticeDeliveryId: noticeId,
    title: "Teste Monitor TI",
    message: "Teste local da nova arquitetura companion.",
    level: "info",
    timestamp: new Date().toISOString(),
    scheduledAt: new Date().toISOString(),
    url: "https://exemplo.local"
  });
  check("NOTICE-001 notice_show válido", ok === true);
  const noticeLine = JSON.parse(await client.nextLine());
  check("NOTICE-001 payload enviado", noticeLine.type === "notice_show" && noticeLine.noticeDeliveryId === noticeId && noticeLine.url === "https://exemplo.local");

  client.send({ type: "received", protocolVersion: PROTOCOL_VERSION, noticeDeliveryId: noticeId, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  await wait(50);
  check("NOTICE-003 Form.Shown=>received", rt.serverEvents.some((e) => e.type === "notice_received" && e.noticeDeliveryId === noticeId));

  client.send({ type: "acknowledged", protocolVersion: PROTOCOL_VERSION, noticeDeliveryId: noticeId, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  await wait(50);
  check("NOTICE-004 ENTENDI=>acknowledged", rt.serverEvents.some((e) => e.type === "notice_acknowledged" && e.noticeDeliveryId === noticeId));
  check("READY volta após acknowledged", rt.runtime.getState().connections[0] && rt.runtime.getState().connections[0].state === NOTIFIER_STATES.READY);

  const noticeA = uuid();
  const noticeB = uuid();
  const okA = rt.runtime.enqueueFromServer({ noticeDeliveryId: noticeA, title: "A", message: "Mensagem A", level: "info", timestamp: new Date().toISOString() });
  check("NOTICE-005 notice A enfileirado", okA === true);
  const lineA = JSON.parse(await client.nextLine());
  check("NOTICE-005 notice A recebida", lineA.noticeDeliveryId === noticeA);
  const okB = rt.runtime.enqueueFromServer({ noticeDeliveryId: noticeB, title: "B", message: "Mensagem B", level: "info", timestamp: new Date().toISOString() });
  check("NOTICE-005 segundo notice durante BUSY rejeitado", okB === false);
  let secondVisible = false;
  try {
    const maybe = await Promise.race([client.nextLine(300), wait(300).then(() => null)]);
    secondVisible = !!maybe && JSON.parse(maybe).noticeDeliveryId === noticeB;
  } catch {
    secondVisible = false;
  }
  check("NOTICE-005 não abre segunda janela", secondVisible === false);
  client.send({ type: "received", protocolVersion: PROTOCOL_VERSION, noticeDeliveryId: noticeA, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  client.send({ type: "acknowledged", protocolVersion: PROTOCOL_VERSION, noticeDeliveryId: noticeA, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  await wait(50);

  client.close();
  await wait(150);
  check("RECONNECT-001 Notifier kill", rt.runtime.getState().connections.length === 0);

  const client2 = await connectClient(rt.path);
  client2.send({ type: "register", protocolVersion: PROTOCOL_VERSION, notifierVersion: AGENT_VERSION, sessionId: rt.sessionId, pid: 1234, username: rt.username, activeNoticeDeliveryId: null });
  await client2.nextLine();
  client2.send({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, sessionId: rt.sessionId, pid: 1234, ts: new Date().toISOString() });
  await wait(50);
  check("RECONNECT-002 Notifier reconnect", rt.runtime.getState().connections[0] && rt.runtime.getState().connections[0].state === NOTIFIER_STATES.READY);
  client2.close();

  rt.runtime.stop();
  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

run().catch((err) => {
  console.error("ERRO no teste:", err.stack || err.message);
  process.exit(1);
});
