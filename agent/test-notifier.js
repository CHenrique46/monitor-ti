process.env.MTI_TEST_AUTO_ACK = "1";
const crypto = require("crypto");
const events = require("events");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");

// O teste cobre o protocolo do Agent sem depender de um binário ignorado pelo Git.
childProcess.spawn = (_exe, args) => {
  const child = new events.EventEmitter();
  const pipePath = "\\\\.\\pipe\\" + args[1];
  setTimeout(() => {
    const socket = net.createConnection(pipePath, () => socket.write("received\nacknowledged\n"));
    socket.on("error", () => {});
  }, 10);
  return child;
};

const { createNotifier } = require("./src/notifier");

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const tmpCfg = fs.mkdtempSync(path.join(os.tmpdir(), "mti-nt-"));
const deviceId = uuid();
const fakeNotifier = path.join(tmpCfg, "MonitorTI-Notifier.exe");
fs.writeFileSync(fakeNotifier, "MonitorTI notifier test fixture");
fs.writeFileSync(path.join(tmpCfg, "notifier-integrity.json"), JSON.stringify({
  version: "test",
  notifierSha256: crypto.createHash("sha256").update(fs.readFileSync(fakeNotifier)).digest("hex")
}));

function makeWs() {
  const rec = [];
  return { rec, send: (m) => rec.push(JSON.parse(m)), readyState: 1 };
}

const notifier = createNotifier({
  configDir: tmpCfg,
  getAppDir: () => tmpCfg,
  getDeviceId: () => deviceId,
  getWs: () => ({ send: () => {}, readyState: 1 }),
  logEvent: (m) => console.log("[agent] " + m),
});

function waitFor(pred, ms) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(true); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("timeout")); }
    }, 150);
  });
}

function findType(rec, type, id) {
  return rec.some((r) => r.type === type && (!id || (r.data && r.data.noticeDeliveryId === id)));
}

(async () => {
  // Test A: aviso novo -> received + acknowledged
  const id = uuid();
  const wsA = makeWs();
  notifier.handleNoticeShow(wsA, {
    type: "notice_show",
    data: {
      noticeDeliveryId: id,
      title: "Aviso de Teste <b>x</b>",
      message: "Mensagem de teste do Agent -> Notifier IPC.",
      level: "urgente",
      scheduledAt: new Date().toISOString(),
      serverTime: new Date().toISOString(),
    },
  });
  await waitFor(() => findType(wsA.rec, "notice_received", id), 20000);
  console.log("PASS A1: notice_received enviado ao servidor");
  await waitFor(() => findType(wsA.rec, "notice_acknowledged", id), 20000);
  console.log("PASS A2: notice_acknowledged enviado ao servidor");

  // Test B: reenvio do mesmo id (ja CONFIRMADO) -> re-sincroniza, sem nova janela
  const wsB = makeWs();
  notifier.handleNoticeShow(wsB, {
    type: "notice_show",
    data: {
      noticeDeliveryId: id,
      title: "z",
      message: "w",
      level: "urgente",
      timestamp: new Date().toISOString()
    }
  });
  await waitFor(() => findType(wsB.rec, "notice_acknowledged", id), 5000);
  if (findType(wsB.rec, "notice_received")) throw new Error("janela duplicada criada para aviso ja confirmado");
  console.log("PASS B: aviso ja confirmado re-sincroniza sem exibir de novo");

  // Test C: id invalido -> ignorado (sem janela)
  const wsC = makeWs();
  notifier.handleNoticeShow(wsC, { type: "notice_show", data: { noticeDeliveryId: "nao-e-uuid", title: "x", message: "y" } });
  await new Promise((r) => setTimeout(r, 1500));
  if (wsC.rec.length) throw new Error("notice_show com id invalido nao foi ignorado");
  console.log("PASS C: id invalido ignorado");

  // Test D: cache contem CONFIRMADO
  const cache = JSON.parse(fs.readFileSync(path.join(tmpCfg, "notice-cache.json"), "utf8"));
  if (!cache[id] || cache[id].state !== "CONFIRMADO") throw new Error("cache nao marcou CONFIRMADO");
  console.log("PASS D: notice-cache.json marcou CONFIRMADO");

  console.log("\nALL TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("\nTEST FAILED: " + e.message);
  process.exit(1);
});
