const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createNoticeRuntime, normalizeWindowsUsername } = require("../agent/src/notices/runtime");
const { PROTOCOL_VERSION } = require("../agent/src/notices/protocol");

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

function pipePath(name) {
  return "\\\\.\\pipe\\" + name;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createClient(pathName) {
  const socket = net.createConnection(pathName);
  socket.setEncoding("utf8");
  let buffer = "";
  const queue = [];

  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line) queue.push(line);
    }
  });

  return {
    socket,
    waitConnect() {
      return new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    },
    waitClose(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout aguardando close")), timeoutMs);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    send(obj) {
      socket.write(JSON.stringify(obj) + "\n");
    },
    nextLine(timeoutMs = 5000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout aguardando linha")), timeoutMs);
        let settled = false;
        const iv = setInterval(() => {
          if (queue.length) {
            clearTimeout(timer);
            clearInterval(iv);
            settled = true;
            resolve(queue.shift());
          }
        }, 20);
        socket.once("close", () => {
          clearTimeout(timer);
          clearInterval(iv);
          if (!settled) reject(new Error("socket fechado antes da linha"));
        });
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

async function registerOutcome({ interactiveUser, ownerDomain, ownerUser, registerUsername, expectClose = false }) {
  const configDir = tempDir("mti-user-normalization-");
  const name = "MTI-USER-" + uuid();
  const runtime = createNoticeRuntime({
    configDir,
    getDeviceId: () => "device-user-normalization",
    getAppDir: () => configDir,
    logEvent: () => {},
    version: "1.1.14-dev",
    getInteractiveUser: () => interactiveUser,
    pipeName: name,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 250,
    processInfoLookup: () => ({ exists: true, sessionId: 1, domain: ownerDomain, user: ownerUser, path: "C:\\Test\\MonitorTI-Notifier.exe" })
  });

  runtime.start();
  const client = await connectClient(pipePath(name));
  client.send({
    type: "register",
    protocolVersion: PROTOCOL_VERSION,
    notifierVersion: "1.1.14-dev",
    sessionId: 1,
    pid: 12345,
    username: registerUsername,
    activeNoticeDeliveryId: null
  });

  const line = expectClose ? null : JSON.parse(await client.nextLine());
  if (expectClose) {
    await client.waitClose();
  }
  client.close();
  runtime.stop();
  return line;
}

async function run() {
  assert.strictEqual(normalizeWindowsUsername("DESKTOP\\Henrique"), "henrique");
  assert.strictEqual(normalizeWindowsUsername("EMPRESA\\Henrique"), "henrique");
  assert.strictEqual(normalizeWindowsUsername("Henrique"), "henrique");
  assert.strictEqual(normalizeWindowsUsername(" HENRIQUE "), "henrique");

  const a = await registerOutcome({
    interactiveUser: "Henrique",
    ownerDomain: "DESKTOP",
    ownerUser: "Henrique",
    registerUsername: "DESKTOP\\Henrique"
  });
  assert.strictEqual(a.type, "register_ok");

  const b = await registerOutcome({
    interactiveUser: "EMPRESA\\Henrique",
    ownerDomain: "",
    ownerUser: "Henrique",
    registerUsername: "Henrique"
  });
  assert.strictEqual(b.type, "register_ok");

  const c = await registerOutcome({
    interactiveUser: "OutroUsuario",
    ownerDomain: "DESKTOP",
    ownerUser: "Henrique",
    registerUsername: "DESKTOP\\Henrique",
    expectClose: true
  });
  assert.strictEqual(c, null);

  const d = await registerOutcome({
    interactiveUser: "HENRIQUE",
    ownerDomain: "",
    ownerUser: "henrique",
    registerUsername: "henrique"
  });
  assert.strictEqual(d.type, "register_ok");

  const e = await registerOutcome({
    interactiveUser: " Henrique ",
    ownerDomain: "DESKTOP",
    ownerUser: "Henrique",
    registerUsername: "DESKTOP\\Henrique"
  });
  assert.strictEqual(e.type, "register_ok");

  console.log("PASS username normalization");
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
