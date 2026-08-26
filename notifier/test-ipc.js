const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const deliveryId = uuid();
const pipeName = "MonitorTI-Notice-" + deliveryId;
const pipePath = "\\\\.\\pipe\\" + pipeName;
const notifier = path.resolve(__dirname, "..", "release", "agent-test", "MonitorTI-Notifier.exe");

const payload = {
  noticeDeliveryId: deliveryId,
  title: "Teste de Aviso <script>alert(1)</script>",
  message: "Mensagem com acentuação: ção ãõ é î.\nLinha dois.\nTerceira linha longa para testar quebra de texto e rolagem quando o conteúdo excede o tamanho previsto da janela de aviso do MonitorTI.",
  level: "URGENTE",
  scheduledAt: new Date().toISOString(),
  serverTime: new Date().toISOString(),
};

const tmp = path.join(os.tmpdir(), "mti-payload-" + deliveryId + ".json");
fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");

const received = [];
let done = false;

const server = net.createServer(sock => {
  sock.setEncoding("utf8");
  sock.on("data", d => {
    d.split("\n").forEach(line => {
      line = line.trim();
      if (!line) return;
      received.push(line);
      console.log("[pipe] <- " + line);
      if (line === "acknowledged" && !done) {
        done = true;
        console.log("RESULT: received=" + received.includes("received") + " acknowledged=" + received.includes("acknowledged"));
        cleanup(0);
      }
    });
  });
});

function cleanup(code) {
  try { server.close(); } catch (e) {}
  try { fs.unlinkSync(tmp); } catch (e) {}
  try { child.kill(); } catch (e) {}
  process.exit(code);
}

server.on("error", err => { console.error("PIPE ERROR: " + err.message); cleanup(2); });

server.listen(pipePath, () => {
  console.log("Pipe server up: " + pipePath);
  const child = spawn(notifier, ["--pipe", pipeName, "--payload", tmp, "--auto-ack"], { windowsHide: false });
  child.on("error", e => { console.error("SPAWN ERROR: " + e.message); cleanup(2); });
  child.stderr.on("data", d => console.error("[notifier stderr] " + d.toString()));
  setTimeout(() => {
    if (!done) {
      console.log("TIMEOUT. received=" + JSON.stringify(received));
      cleanup(1);
    }
  }, 20000);
});
