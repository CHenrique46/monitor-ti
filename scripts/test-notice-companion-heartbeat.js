const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function compileNotifier(outDir) {
  const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  if (!fs.existsSync(csc)) {
    throw new Error("csc.exe nao encontrado em " + csc);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const source = path.join(repoRoot, "notifier", "MonitorTI-Notifier.cs");
  const outExe = path.join(outDir, "MonitorTI-Notifier-test.exe");

  execFileSync(
    csc,
    [
      "/nologo",
      "/target:exe",
      "/platform:anycpu",
      "/out:" + outExe,
      "/r:System.Windows.Forms.dll",
      "/r:System.Drawing.dll",
      "/r:System.Core.dll",
      source
    ],
    { cwd: repoRoot, stdio: "pipe" }
  );

  return outExe;
}

async function run() {
  const tempRoot = path.join(os.tmpdir(), "mti-heartbeat-test");
  ensureDir(tempRoot);
  const workDir = path.join(tempRoot, uuid());
  ensureDir(workDir);

  const notifierExe = compileNotifier(workDir);
  const name = "MTI-HB-" + uuid();
  const pathName = pipePath(name);
  const heartbeats = [];
  let connections = 0;
  let registerSeen = false;

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pathName, resolve);
  });

  const serverClosed = new Promise((resolve) => server.once("close", resolve));

  server.on("connection", (socket) => {
    connections += 1;
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === "register") {
          registerSeen = true;
          socket.write(JSON.stringify({
            type: "register_ok",
            protocolVersion: 1,
            agentVersion: "1.1.14-dev",
            heartbeatIntervalMs: 100,
            heartbeatTimeoutMs: 45000,
            maxMessageBytes: 65536,
            selectedSession: 1,
            noticesEnabled: true
          }) + "\n");
          continue;
        }
        if (msg.type === "heartbeat") {
          heartbeats.push(Date.now());
        }
      }
    });
  });

  const proc = spawn(notifierExe, ["--companion"], {
    cwd: workDir,
    env: {
      ...process.env,
      MTI_COMPANION_PIPE_NAME: name,
      MTI_COMPANION_HEARTBEAT_MS: "100"
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  proc.stderr.on("data", (d) => stderr.push(String(d)));

  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (registerSeen && heartbeats.length >= 4) break;
      await wait(25);
    }

    assert.strictEqual(connections, 1, "esperado uma unica conexao");
    assert.strictEqual(registerSeen, true, "register nao recebido");
    assert.ok(heartbeats.length >= 4, `esperado >=4 heartbeats, recebido ${heartbeats.length}`);

    const span = heartbeats[heartbeats.length - 1] - heartbeats[0];
    assert.ok(span < 1200, `heartbeats nao pareceram periodicos; span=${span}ms`);

    console.log("PASS companion heartbeat periodic");
  } finally {
    try { proc.kill(); } catch {}
    try {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        proc.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } catch {}
    try { server.close(); } catch {}
    await serverClosed.catch(() => {});
    if (stderr.length) {
      fs.writeFileSync(path.join(workDir, "notifier-stderr.log"), stderr.join(""), "utf8");
    }
  }
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
