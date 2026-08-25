const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const checkDiskSpace = require("check-disk-space").default;

const RECONNECT_DELAY = 5000;
const METRICS_INTERVAL = 10000;
const DISK_PATH = "C:";
const DEFAULT_SERVER_URL = "ws://192.168.40.70:4000";

// Diretório do executável/agente (funciona tanto em dev quanto empacotado)
function isPackaged() {
  if (process.pkg) return true;
  if (process.sea) return true;
  // SEA: o proprio executavel roda o script (nao e node.exe chamando arquivo)
  const exe = path.basename(process.execPath).toLowerCase();
  if (exe !== "node.exe") return true;
  return false;
}

function getAppDir() {
  if (isPackaged()) return path.dirname(process.execPath);
  return path.join(__dirname, "..");
}

// Local do deviceId e logs:
//  - versão empacotada (portátil): %ProgramData%\MonitorTI (fora da pasta do exe)
//  - dev: agent/data (compatível com o que já existe)
function getConfigDir() {
  if (isPackaged()) {
    const base = process.env.ProgramData || "C:\\ProgramData";
    return path.join(base, "MonitorTI");
  }
  return path.join(__dirname, "..", "data");
}

const CONFIG_DIR = getConfigDir();
const CONFIG_FILE = path.join(CONFIG_DIR, "agent-config.json");
const LOG_FILE = isPackaged()
  ? path.join(CONFIG_DIR, "logs", "agent.log")
  : null;

function logEvent(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (LOG_FILE) {
    try {
      if (!fs.existsSync(path.dirname(LOG_FILE)))
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, line + "\n");
    } catch (e) {
      // falha de log não deve interromper o agente
    }
  }
}

function getServerUrl() {
  const cfgPath = path.join(getAppDir(), "config.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    if (cfg && typeof cfg.serverUrl === "string" && cfg.serverUrl.trim()) {
      return cfg.serverUrl.trim();
    }
  } catch (e) {
    // arquivo ausente/corrompido: usa o default
  }
  return DEFAULT_SERVER_URL;
}

const SERVER_URL = getServerUrl();

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
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ deviceId }, null, 2));
  } catch (e) {
    logEvent("ERRO ao salvar deviceId: " + e.message);
  }
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

  const cpus = os.cpus();

  return {
    deviceId,
    hostname: os.hostname(),
    usuario: os.userInfo().username,
    ip,
    sistema: os.platform(),
    arquitetura: os.arch(),
    processador: cpus[0] ? cpus[0].model : null,
    cpusLogicas: cpus.length,
    sistemaRelease: os.release()
  };
}

// CPU: delta dos tempos de os.cpus() entre duas amostras (nao usa loadavg)
let cpuPrev = null;

function cpuUsagePercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }

  if (!cpuPrev) {
    cpuPrev = { idle, total };
    return 0;
  }

  const idleDelta = idle - cpuPrev.idle;
  const totalDelta = total - cpuPrev.total;
  cpuPrev = { idle, total };

  if (totalDelta <= 0) return 0;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
}

async function collectMetrics(deviceId) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let discoTotal = null;
  let discoLivre = null;
  try {
    const disk = await checkDiskSpace(DISK_PATH);
    discoTotal = disk.size;
    discoLivre = disk.free;
  } catch (e) {
    logEvent("ERRO ao coletar disco: " + e.message);
  }

  return {
    deviceId,
    cpu: cpuUsagePercent(),
    ramTotal: totalMem,
    ramUsada: totalMem - freeMem,
    discoTotal,
    discoLivre,
    uptime: Math.floor(os.uptime())
  };
}

let metricsTimer = null;

function stopMetrics() {
  if (metricsTimer) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

function startMetrics(ws, machine) {
  stopMetrics(); // garante um unico timer ativo
  metricsTimer = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const metrics = await collectMetrics(machine.deviceId);
      ws.send(JSON.stringify({ type: "metrics", data: metrics }));
    } catch (e) {
      // ignora falha pontual
    }
  }, METRICS_INTERVAL);
}

function connect(machine) {
  logEvent(`Tentando conectar em ${SERVER_URL}`);
  const ws = new WebSocket(SERVER_URL);

  ws.on("open", () => {
    logEvent("Conectado ao Monitor TI Server.");
    ws.send(JSON.stringify({ type: "register", data: machine }));
    startMetrics(ws, machine);
  });

  ws.on("error", () => {
    // erros de conexao sao tratados no 'close'
  });

  ws.on("close", () => {
    stopMetrics();
    logEvent("Desconectado do servidor.");
    logEvent(`Tentando reconectar em ${RECONNECT_DELAY / 1000}s...`);
    setTimeout(() => connect(machine), RECONNECT_DELAY);
  });
}

function shutdown() {
  logEvent("Agent encerrado.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logEvent("Monitor TI Agent iniciado.");
const deviceId = getDeviceId();
logEvent("deviceId: " + deviceId);
const machine = getMachineInfo(deviceId);
cpuUsagePercent(); // baseline da CPU
connect(machine);
