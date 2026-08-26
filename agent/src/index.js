const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const checkDiskSpace = require("check-disk-space").default;
const { execFile } = require("child_process");

const RECONNECT_DELAY = 5000;
const METRICS_INTERVAL = 10000;
const DISK_PATH = "C:";
const DEFAULT_SERVER_URL = "ws://192.168.40.70:4000";
const PS_TIMEOUT = 10000;

function runPsJson(script) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ],
      { timeout: PS_TIMEOUT, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error("resposta invalida do PowerShell"));
        }
      }
    );
  });
}

const GENERIC_SERIAL = ["to be filled by o.e.m.", "default string", "", " "];
function normalizeSerial(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (GENERIC_SERIAL.includes(v.toLowerCase())) return null;
  return v;
}

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
    const raw = fs.readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw.replace(/^﻿/, ""));
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
      const raw = fs.readFileSync(CONFIG_FILE, "utf8");
      const cfg = JSON.parse(raw.replace(/^﻿/, ""));
      if (cfg.deviceId) return cfg.deviceId;
    }
  } catch (e) {
    // arquivo corrompido (ex.: BOM/UTF-8): ignora e gera novo
    logEvent("aviso: falha ao ler deviceId existente: " + e.message);
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
    // usuario e preenchido de forma assincrona (collectInteractiveUser) antes do register
    usuario: null,
    ip,
    sistema: os.platform(),
    arquitetura: os.arch(),
    processador: cpus[0] ? cpus[0].model : null,
    cpusLogicas: cpus.length,
    sistemaRelease: os.release()
  };
}

async function collectAdvancedInventory() {
  logEvent("Coletando inventario de hardware...");
  const start = Date.now();
  const result = {};

  try {
    const cs = await runPsJson(
      "Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress"
    );
    result.fabricante = cs.Manufacturer || null;
    result.modeloEquipamento = cs.Model || null;
  } catch (e) {
    logEvent("Falha ao coletar ComputerSystem: " + e.message);
  }

  try {
    const bb = await runPsJson(
      "Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product | ConvertTo-Json -Compress"
    );
    result.placaMaeFabricante = bb.Manufacturer || null;
    result.placaMaeModelo = bb.Product || null;
  } catch (e) {
    logEvent("Falha ao coletar BaseBoard: " + e.message);
  }

  try {
    const bios = await runPsJson(
      "Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,SerialNumber | ConvertTo-Json -Compress"
    );
    result.biosFabricante = bios.Manufacturer || null;
    result.biosVersao = bios.SMBIOSBIOSVersion || null;
    result.numeroSerie = normalizeSerial(bios.SerialNumber);
  } catch (e) {
    logEvent("Falha ao coletar BIOS: " + e.message);
  }

  try {
    let disks = await runPsJson(
      "Get-CimInstance Win32_DiskDrive | Select-Object Model,Size,InterfaceType | ConvertTo-Json -Compress"
    );
    if (disks && !Array.isArray(disks)) disks = [disks];
    result.discosFisicos = (disks || []).map((d) => ({
      modelo: d.Model || null,
      tamanho: d.Size != null ? Number(d.Size) : null,
      interface: d.InterfaceType || null
    }));
  } catch (e) {
    logEvent("Falha ao coletar DiskDrive: " + e.message);
    result.discosFisicos = [];
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  logEvent("Inventario coletado em " + elapsed + "s.");
  return result;
}

// Usuario interativo atualmente logado (funciona tambem como servico/LocalSystem).
// Nunca retorna "SYSTEM": usa Win32_ComputerSystem.UserName (sessao interativa).
// Se nenhum usuario estiver logado, retorna null.
async function collectInteractiveUser() {
  try {
    const cs = await runPsJson(
      "Get-CimInstance Win32_ComputerSystem | Select-Object UserName | ConvertTo-Json -Compress"
    );
    const raw = cs && cs.UserName ? String(cs.UserName).trim() : "";
    if (!raw) return { usuario: null };
    const parts = raw.split("\\");
    return { usuario: parts[parts.length - 1] || null };
  } catch (e) {
    logEvent("Falha ao coletar usuario interativo: " + e.message);
    return { usuario: null };
  }
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
let activeWs = null;

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
  activeWs = ws;

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
  stopMetrics();
  if (activeWs) {
    try {
      if (activeWs.readyState === WebSocket.OPEN) activeWs.close();
    } catch (e) {
      // ignora erro ao fechar
    }
    activeWs = null;
  }
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

// Inventario avancado + usuario interativo: coletados uma unica vez na
// inicializacao (antes do register). Falhas nao impedem o registro.
Promise.allSettled([collectAdvancedInventory(), collectInteractiveUser()])
  .then(([inv, usr]) => {
    const adv = inv.status === "fulfilled" ? inv.value : {};
    const u = usr.status === "fulfilled" ? usr.value : {};
    Object.assign(machine, adv, u);
    connect(machine);
  });
