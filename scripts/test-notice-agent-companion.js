const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createNoticeBridge } = require("../agent/src/notices/bridge");
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

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    }
  };
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

async function main() {
  const logs = [];
  let legacyFactoryCalls = 0;

  const companionBridge = createNoticeBridge(
    {
      configDir: tempDir("mti-companion-int-"),
      getAppDir: () => path.join(__dirname, "..", "release", "agent-test"),
      getDeviceId: () => "device-companion",
      getServerHttpBase: () => "http://127.0.0.1:0",
      logEvent: (m) => logs.push(m),
      version: AGENT_VERSION,
      getInteractiveUser: () => "Henrique",
      processInfoLookup: () => ({ exists: true, sessionId: 1, domain: "", user: "Henrique", path: "C:\\Test\\companion.exe" }),
      companionEnabled: true
    },
    {
      createNotifier() {
        legacyFactoryCalls += 1;
        throw new Error("legacy nao deve ser criado no modo companion");
      }
    }
  );

  const ws = createWs();
  companionBridge.onWsOpen(ws);
  check("INT-001 Agent companion inicia pipe", !!companionBridge.getRuntimeState() && !!companionBridge.getRuntimeState().pipePath);
  check("INT-009 companion nao chama fluxo legado", legacyFactoryCalls === 0);
  check("INT-013 companion default", companionBridge.isCompanionMode === true);

  const pipePath = companionBridge.getRuntimeState().pipePath;
  const client = await connectClient(pipePath);
  client.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.7", sessionId: 1, pid: 7777, username: "Henrique", activeNoticeDeliveryId: null });
  const registerOk = JSON.parse(await client.nextLine());
  check("INT-002 Notifier register -> READY", registerOk.type === "register_ok");
  client.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 7777, ts: new Date().toISOString() });
  await wait(100);
  check("INT-003 capability false -> true", ws.sent.some((m) => m.type === "capabilities" && Array.isArray(m.data && m.data.capabilities) && m.data.capabilities.includes("notices")));

  const noticeId = uuid();
  const noticePayload = {
    type: "notice_show",
    data: {
      noticeDeliveryId: noticeId,
      title: "Teste Monitor TI",
      message: "Teste local da nova arquitetura companion.",
      level: "info",
      timestamp: new Date().toISOString(),
      scheduledAt: new Date().toISOString(),
      url: "https://exemplo.local/monitor-ti"
    }
  };
  check("INT-004 notice_show enfileirado no runtime", companionBridge.handleServerMessage(ws, noticePayload) === true);
  const routedLine = JSON.parse(await client.nextLine());
  check("INT-004 uma entrega no pipe", routedLine.type === "notice_show" && routedLine.noticeDeliveryId === noticeId);

  client.send({ type: "received", protocolVersion: 1, noticeDeliveryId: noticeId, sessionId: 1, pid: 7777, ts: new Date().toISOString() });
  client.send({ type: "acknowledged", protocolVersion: 1, noticeDeliveryId: noticeId, sessionId: 1, pid: 7777, ts: new Date().toISOString() });
  await wait(100);
  check("INT-005 received -> notice_received", ws.sent.some((m) => m.type === "notice_received" && m.noticeDeliveryId === noticeId));
  check("INT-006 acknowledged -> notice_acknowledged", ws.sent.some((m) => m.type === "notice_acknowledged" && m.noticeDeliveryId === noticeId));

  const busyA = uuid();
  const busyB = uuid();
  check("INT-011 primeiro notice aceita", companionBridge.handleServerMessage(ws, { type: "notice_show", data: { noticeDeliveryId: busyA, title: "A", message: "Mensagem A", level: "info", timestamp: new Date().toISOString() } }) === true);
  const busyLine = JSON.parse(await client.nextLine());
  check("INT-011 primeiro notice roteado", busyLine.noticeDeliveryId === busyA);
  check("INT-011 segundo notice enquanto BUSY rejeitado", companionBridge.handleServerMessage(ws, { type: "notice_show", data: { noticeDeliveryId: busyB, title: "B", message: "Mensagem B", level: "info", timestamp: new Date().toISOString() } }) === false);

  client.close();
  await wait(300);
  check("INT-007 kill companion -> notices capability false", ws.sent.some((m) => m.type === "capabilities" && Array.isArray(m.data && m.data.capabilities) && !m.data.capabilities.includes("notices")));

  const client2 = await connectClient(pipePath);
  client2.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.7", sessionId: 1, pid: 8888, username: "Henrique", activeNoticeDeliveryId: null });
  await client2.nextLine();
  client2.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 8888, ts: new Date().toISOString() });
  await wait(100);
  check("INT-008 reconnect -> capability true", ws.sent.filter((m) => m.type === "capabilities").some((m) => Array.isArray(m.data && m.data.capabilities) && m.data.capabilities.includes("notices")));

  companionBridge.shutdown();
  check("INT-012 Agent shutdown fecha runtime", companionBridge.getRuntimeState() && companionBridge.getRuntimeState().started === false);
  client2.close();

  let legacyNoticeCalls = 0;
  const legacyBridge = createNoticeBridge(
    {
      configDir: tempDir("mti-legacy-int-"),
      getAppDir: () => path.join(__dirname, "..", "release", "agent-test"),
      getDeviceId: () => "device-legacy",
      getServerHttpBase: () => "http://127.0.0.1:0",
      logEvent: () => {},
      version: "1.1.7",
      getInteractiveUser: () => "Henrique",
      companionEnabled: false
    },
    {
      createNoticeRuntime() {
        throw new Error("runtime nao deve ser criado no modo legado");
      },
      createNotifier() {
        return {
          ensureNotifierPresent() {},
          start() {},
          handleNoticeShow() {
            legacyNoticeCalls += 1;
          },
          isNotifierReady() {
            return true;
          }
        };
      }
    }
  );
  const legacyWs = createWs();
  legacyBridge.onWsOpen(legacyWs);
  legacyBridge.handleServerMessage(legacyWs, { type: "notice_show", data: { noticeDeliveryId: uuid(), title: "L", message: "L", level: "info", timestamp: new Date().toISOString() } });
  check("INT-010 flag ausente mantém fluxo legado", legacyNoticeCalls === 1);

  const oldBridge = createNoticeBridge(
    {
      configDir: tempDir("mti-old-int-"),
      getAppDir: () => path.join(__dirname, "..", "release", "agent-test"),
      getDeviceId: () => "device-old",
      getServerHttpBase: () => "http://127.0.0.1:0",
      logEvent: () => {},
      version: "1.1.6",
      getInteractiveUser: () => "Henrique"
    },
    {
      createNoticeRuntime() {
        throw new Error("runtime nao deve ser criado em 1.1.6");
      },
      createNotifier() {
        return {
          ensureNotifierPresent() {},
          start() {},
          handleNoticeShow() {},
          isNotifierReady() { return false; }
        };
      }
    }
  );
  check("INT-014 1.1.6 legacy default", oldBridge.isCompanionMode === false);

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
