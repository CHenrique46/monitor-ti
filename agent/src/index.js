const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const CONFIG_DIR = path.join(__dirname, "..", "data");
const CONFIG_FILE = path.join(CONFIG_DIR, "agent-config.json");
const SERVER_URL = "ws://127.0.0.1:4000";
const RECONNECT_DELAY = 5000;

function getDeviceId() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      if (cfg.deviceId) return cfg.deviceId;
    }
  } catch (e) {
    // arquivo corrompido: ignora e gera novo
  }

  const deviceId = crypto.randomUUID();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId }, null, 2));
  return deviceId;
}

function getMachineInfo(deviceId) {
  let ip = null;
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        ip = iface.address;
        break;
      }
    }
    if (ip) break;
  }

  return {
    deviceId,
    hostname: os.hostname(),
    usuario: os.userInfo().username,
    ip,
    sistema: os.platform()
  };
}

function connect(machine) {
  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    console.log("Conectado ao Monitor TI Server.");
    ws.send(JSON.stringify({ type: "register", data: machine }));
  });

  ws.on("error", () => {
    // erros de conexao sao tratados no 'close'
  });

  ws.on("close", () => {
    console.log("Servidor indisponível. Tentando reconectar...");
    setTimeout(() => connect(machine), RECONNECT_DELAY);
  });
}

console.log("Monitor TI Agent iniciado.");

const deviceId = getDeviceId();
const machine = getMachineInfo(deviceId);
connect(machine);
