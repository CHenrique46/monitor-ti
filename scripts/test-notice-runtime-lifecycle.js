const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createNoticeRuntime } = require("../agent/src/notices/runtime");
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

function currentUser() {
  const user = os.userInfo().username;
  const domain = process.env.USERDOMAIN || "";
  return domain ? domain + "\\" + user : user;
}

function processInfoLookup(sessionId, username) {
  return (pid) => ({
    exists: true,
    sessionId,
    domain: username.includes("\\") ? username.split("\\")[0] : "",
    user: username.includes("\\") ? username.split("\\")[1] : username,
    path: "C:\\Test\\MonitorTI-Notifier.exe",
    pid
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred, timeoutMs = 5000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await wait(stepMs);
  }
  return false;
}

function createClient(pathName) {
  const socket = net.createConnection(pathName);
  socket.setEncoding("utf8");
  const lines = [];
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx < 0) break;
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (line) lines.push(line);
    }
  });

  return {
    socket,
    lines,
    waitConnect(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
    nextLine(timeoutMs = 5000) {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout esperando linha")), timeoutMs);
        const iv = setInterval(() => {
          if (lines.length) {
            clearTimeout(timer);
            clearInterval(iv);
            resolve(lines.shift());
          }
        }, 20);
        socket.once("close", () => {
          clearTimeout(timer);
          clearInterval(iv);
        });
      });
    },
    send(obj) {
      socket.write(JSON.stringify(obj) + "\n");
    },
    close() {
      try { socket.end(); } catch {}
    }
  };
}

async function registerAndHeartbeat(client, sessionId, pid, username) {
  client.send({
    type: "register",
    protocolVersion: PROTOCOL_VERSION,
    notifierVersion: "1.1.10",
    sessionId,
    pid,
    username,
    activeNoticeDeliveryId: null
  });
  const reg = JSON.parse(await client.nextLine(5000));
  assert.strictEqual(reg.type, "register_ok");

  client.send({
    type: "heartbeat",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    pid,
    ts: new Date().toISOString()
  });
}

async function connectRegisterReady(runtime, pathName, sessionId, pid, username) {
  const client = createClient(pathName);
  await client.waitConnect(5000);
  await registerAndHeartbeat(client, sessionId, pid, username);
  await waitFor(() => {
    const snap = runtime.getState();
    return snap.listening === true;
  }, 200);
  return client;
}

function makeRuntime(pipeName, sessionId = 7) {
  const configDir = tempDir("mti-runtime-lifecycle-");
  const username = currentUser();
  const runtime = createNoticeRuntime({
    configDir,
    getDeviceId: () => "device-test",
    getAppDir: () => configDir,
    logEvent: () => {},
    version: "1.1.10",
    getInteractiveUser: () => username,
    pipeName,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 250,
    processInfoLookup: processInfoLookup(sessionId, username)
  });
  return { runtime, configDir, username, sessionId };
}

async function occupyPipe(name) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ path: pipePath(name), readableAll: true, writableAll: true }, resolve);
  });
  return server;
}

async function expectPipeTimeout(pathName, timeoutMs = 1000) {
  const client = net.createConnection(pathName);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    client.once("connect", () => {
      clearTimeout(timer);
      client.end();
      reject(new Error("unexpected connect"));
    });
    client.once("error", (err) => {
      clearTimeout(timer);
      resolve(err);
    });
  }).catch((err) => {
    if (err && err.message === "unexpected connect") throw err;
    return err;
  });
}

async function run() {
  const nameA = "MTI-Life-A-" + uuid();
  const rtA = makeRuntime(nameA);
  rtA.runtime.start();
  assert.strictEqual(await waitFor(() => rtA.runtime.getState().listening, 5000), true, "runtime A should listen");
  const clientA = await connectRegisterReady(rtA.runtime, pipePath(nameA), rtA.sessionId, 1111, rtA.username);
  clientA.close();
  await waitFor(() => rtA.runtime.getState().connections.length === 0, 2000);
  rtA.runtime.stop();

  const nameB = "MTI-Life-B-" + uuid();
  const occupantB = await occupyPipe(nameB);
  const rtB = makeRuntime(nameB);
  rtB.runtime.start();
  assert.strictEqual(await waitFor(() => rtB.runtime.getState().listenFailures >= 1, 5000), true, "runtime B should hit EADDRINUSE");
  occupantB.close();
  assert.strictEqual(await waitFor(() => rtB.runtime.getState().listening, 7000), true, "runtime B should recover");
  const clientB = await connectRegisterReady(rtB.runtime, pipePath(nameB), rtB.sessionId, 2222, rtB.username);
  clientB.close();
  await waitFor(() => rtB.runtime.getState().connections.length === 0, 2000);
  rtB.runtime.stop();

  const nameC = "MTI-Life-C-" + uuid();
  const rtC = makeRuntime(nameC);
  rtC.runtime.start();
  rtC.runtime.start();
  assert.strictEqual(await waitFor(() => rtC.runtime.getState().listening, 5000), true, "runtime C should listen");
  assert.strictEqual(rtC.runtime.getState().listenFailures, 0, "runtime C should have no listen failures");
  const clientC = await connectRegisterReady(rtC.runtime, pipePath(nameC), rtC.sessionId, 3333, rtC.username);
  clientC.close();
  rtC.runtime.stop();

  const nameD = "MTI-Life-D-" + uuid();
  const occupantD = await occupyPipe(nameD);
  const rtD = makeRuntime(nameD);
  rtD.runtime.start();
  assert.strictEqual(await waitFor(() => rtD.runtime.getState().listenFailures >= 1, 5000), true, "runtime D should hit listen failure");
  rtD.runtime.stop();
  occupantD.close();
  await wait(1000);
  assert.strictEqual(rtD.runtime.getState().listening, false, "runtime D should stay stopped");
  assert.strictEqual(rtD.runtime.getState().listenRetryPending, false, "runtime D retry must be cancelled");
  await expectPipeTimeout(pipePath(nameD), 500);

  const nameE = "MTI-Life-E-" + uuid();
  const rtE = makeRuntime(nameE);
  rtE.runtime.start();
  assert.strictEqual(await waitFor(() => rtE.runtime.getState().listening, 5000), true, "runtime E should listen");
  const clientE1 = await connectRegisterReady(rtE.runtime, pipePath(nameE), rtE.sessionId, 4444, rtE.username);
  clientE1.close();
  await waitFor(() => rtE.runtime.getState().connections.length === 0, 2000);
  const clientE2 = await connectRegisterReady(rtE.runtime, pipePath(nameE), rtE.sessionId, 5555, rtE.username);
  clientE2.close();
  rtE.runtime.stop();

  console.log("PASS runtime lifecycle A-E");
}

run().catch((err) => {
  console.error("FAIL runtime lifecycle:", err && err.stack ? err.stack : err && err.message ? err.message : String(err));
  process.exit(1);
});
