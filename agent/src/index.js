const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");
const checkDiskSpace = require("check-disk-space").default;
const { execFile, spawn } = require("child_process");
const { createNotifier } = require("./notifier");

// Atualizador: se iniciado com --apply-update (arquivo unico) ou
// --apply-update-package (pacote Agent+Notifier), executa apenas a troca e
// encerra (não inicia o agente normal).
if (process.argv.includes("--apply-update") || process.argv.includes("--apply-update-package")) {
  require("./updater").run(process.argv);
  return;
}

// Versão única e canônica do Agent (lida do package.json; inlined no build SEA).
const AGENT_VERSION = require("../package.json").version;
const AGENT_SERVICE_NAME = "MonitorTIAgent";

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

// Módulo de avisos (Notifier): integra notice_show, fila, cache e IPC.
const notifier = createNotifier({
  configDir: CONFIG_DIR,
  getAppDir,
  getDeviceId: () => deviceId,
  getWs: () => activeWs,
  logEvent,
  version: AGENT_VERSION,
  getServerHttpBase: () => SERVER_URL
});

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
    sistemaRelease: os.release(),
    agentVersion: AGENT_VERSION
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
let notifierStarted = false;
let notifierEnsureStarted = false;

// ===== Atualização centralizada do Agent =====

let updating = false; // guarda para não iniciar atualização em paralelo

function sendUpdateStatus(ws, status, version, message) {
  try {
    ws.send(
      JSON.stringify({
        type: "update_status",
        status,
        version: version || null,
        message: message || null,
        deviceId
      })
    );
  } catch (e) {
    // ignore
  }
}

function sha256File(p) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(p));
  return h.digest("hex");
}

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("download falhou (HTTP " + res.status + ")");
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return true;
}

function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const p = spawn("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("falha ao extrair pacote (tar " + code + ")"))
    );
  });
}

async function handleUpdateCommand(ws, msg) {
  if (updating) {
    logEvent("Atualizacao ja em andamento; comando ignorado.");
    return;
  }
  const version = msg.version;
  const expectedSha = msg.sha256;
  const expectedSize = msg.size;
  const isPackage = !!msg.package;
  const expectedNotifierSha = msg.notifierSha256;
  if (!version || !expectedSha) {
    sendUpdateStatus(ws, "update_failed", version, "comando invalido");
    return;
  }

  updating = true;
  logEvent("Atualizacao solicitada para versao " + version + (isPackage ? " (pacote)" : ""));

  let tmpFile = null;
  let packageDir = null;
  try {
    sendUpdateStatus(ws, "update_downloading", version);

    const tmpDir = path.join(CONFIG_DIR, "agent-update");
    fs.mkdirSync(tmpDir, { recursive: true });
    tmpFile = path.join(tmpDir, isPackage ? "package.zip" : "MonitorTI-Agent.new.exe");

    const httpBase = SERVER_URL.replace("ws://", "http://").replace(
      "wss://",
      "https://"
    );
    const url = isPackage
      ? `${httpBase}/api/agent/releases/${version}/package`
      : `${httpBase}/api/agent/releases/${version}/download`;
    logEvent("Baixando atualizacao de " + url);
    await downloadFile(url, tmpFile);

    // Modo pacote (v1.1.0+): extrai e valida Agent + Notifier, aplica via updater em pacote.
    if (isPackage) {
      packageDir = path.join(tmpDir, "package");
      fs.mkdirSync(packageDir, { recursive: true });
      await extractZip(tmpFile, packageDir);
      const agentInPkg = path.join(packageDir, "MonitorTI-Agent.exe");
      if (!fs.existsSync(agentInPkg)) throw new Error("pacote sem MonitorTI-Agent.exe");
      const actualSha = sha256File(agentInPkg);
      if (actualSha.toLowerCase() !== String(expectedSha).toLowerCase())
        throw new Error("SHA-256 do Agent no pacote nao confere");
      if (expectedNotifierSha) {
        const notifInPkg = path.join(packageDir, "MonitorTI-Notifier.exe");
        if (!fs.existsSync(notifInPkg)) throw new Error("pacote sem MonitorTI-Notifier.exe");
        if (sha256File(notifInPkg).toLowerCase() !== String(expectedNotifierSha).toLowerCase())
          throw new Error("SHA-256 do Notifier no pacote nao confere");
      }
      const installExe = process.execPath;
      sendUpdateStatus(ws, "update_validating", version);
      sendUpdateStatus(ws, "update_installing", version);
      logEvent("Iniciando substituicao segura (pacote)...");
      const child = spawn(
        agentInPkg,
        ["--apply-update-package", packageDir, installExe, AGENT_SERVICE_NAME],
        { detached: true, stdio: "ignore", windowsHide: true }
      );
      child.unref();
      setTimeout(() => process.exit(0), 800);
      return;
    }

    // Caminho legado (arquivo unico, v1.0.x).
    const actualSha = sha256File(tmpFile);
    logEvent("SHA-256 esperado: " + expectedSha);
    logEvent("SHA-256 calculado: " + actualSha);
    if (actualSha.toLowerCase() !== String(expectedSha).toLowerCase()) {
      fs.unlinkSync(tmpFile);
      tmpFile = null;
      sendUpdateStatus(ws, "update_failed", version, "SHA-256 nao confere");
      updating = false;
      return;
    }

    sendUpdateStatus(ws, "update_validating", version);
    if (expectedSize && fs.statSync(tmpFile).size !== expectedSize) {
      fs.unlinkSync(tmpFile);
      tmpFile = null;
      sendUpdateStatus(ws, "update_failed", version, "tamanho invalido");
      updating = false;
      return;
    }

    sendUpdateStatus(ws, "update_installing", version);
    logEvent("Iniciando substituicao segura do executavel...");

    const installExe = process.execPath;
    const child = spawn(
      tmpFile,
      ["--apply-update", installExe, AGENT_SERVICE_NAME],
      { detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();

    setTimeout(() => process.exit(0), 800);
  } catch (e) {
    logEvent("ERRO na atualizacao: " + e.message);
    sendUpdateStatus(ws, "update_failed", version, e.message);
    try {
      if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    } catch (e2) {}
    try {
      if (packageDir && fs.existsSync(packageDir)) fs.rmSync(packageDir, { recursive: true, force: true });
    } catch (e2) {}
    updating = false;
  }
}

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

  if (!notifierEnsureStarted) {
    notifierEnsureStarted = true;
    notifier.ensureNotifierPresent();
  }

  ws.on("open", () => {
    logEvent("Conectado ao Monitor TI Server.");
    ws.send(JSON.stringify({ type: "register", data: machine }));
    startMetrics(ws, machine);
    if (!notifierStarted) {
      notifierStarted = true;
      notifier.start(ws);
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (msg && msg.type === "update_agent") {
      handleUpdateCommand(ws, msg).catch(() => {});
    } else if (msg && msg.type === "notice_show") {
      notifier.handleNoticeShow(ws, msg);
    }
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
