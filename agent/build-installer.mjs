import { build } from "esbuild";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import task from "./src/notices/task.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = __dirname;
const repoRoot = path.join(agentRoot, "..");
const installerDir = path.join(repoRoot, "installer");
const agentPackage = JSON.parse(fs.readFileSync(path.join(agentRoot, "package.json"), "utf8"));
const releaseDirName = String(agentPackage.version).endsWith("-dev")
  ? "agent-dev-" + String(agentPackage.version).replace(/-dev$/, "")
  : "agent-" + String(agentPackage.version);
const releaseAgentTest = path.join(repoRoot, "release", releaseDirName);
const outDir = path.join(repoRoot, "release", String(agentPackage.version).endsWith("-dev") ? "installer-dev-" + String(agentPackage.version).replace(/-dev$/, "") : "installer-" + String(agentPackage.version));
const agentExe = path.join(releaseAgentTest, "MonitorTI-Agent.exe");
const notifierSrc = path.join(repoRoot, "notifier", "MonitorTI-Notifier.cs");
const notifierExe = path.join(releaseAgentTest, "MonitorTI-Notifier.exe");
const winswExe = path.join(releaseAgentTest, "WinSW.exe");
const issFile = path.join(installerDir, "MonitorTI-Agent.iss");

const WINSW_URL =
  "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";

function findISCC() {
  const localAppIscc = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "Inno Setup 6",
    "ISCC.exe"
  );
  const fixed = [
    localAppIscc,
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files (x86)\\Inno Setup 5\\ISCC.exe"
  ];
  for (const p of fixed) {
    if (fs.existsSync(p)) return p;
  }
  try {
    execSync("where iscc", { stdio: "ignore" });
    return "iscc";
  } catch {
    return null;
  }
}

async function ensureWinSW() {
  if (fs.existsSync(winswExe)) {
    console.log("WinSW ja presente: " + winswExe);
    return;
  }
  console.log("Baixando WinSW de " + WINSW_URL);
  const res = await fetch(WINSW_URL);
  if (!res.ok) throw new Error("Falha ao baixar WinSW: HTTP " + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(winswExe, buf);
  console.log("WinSW salvo: " + winswExe + " (" + buf.length + " bytes)");
}

async function main() {
  // 1) garante que o agente SEA foi construido
  if (!fs.existsSync(agentExe)) {
    console.log("Agent SEA ausente, construindo...");
    execSync("node build-agent.mjs", { cwd: agentRoot, stdio: "inherit" });
  } else {
    console.log("Agent SEA presente: " + agentExe);
  }

  if (!fs.existsSync(agentExe) || fs.statSync(agentExe).size <= 0) {
    throw new Error("MonitorTI-Agent.exe ausente ou vazio: " + agentExe);
  }
  const agentSize = fs.statSync(agentExe).size;
  const agentHash = crypto.createHash("sha256").update(fs.readFileSync(agentExe)).digest("hex");
  console.log("Agent gerado: " + agentExe);
  console.log("Agent tamanho: " + agentSize + " bytes");
  console.log("Agent SHA256: " + agentHash);

  // O instalador sempre recebe o Notifier recompilado do fonte versionado.
  if (!fs.existsSync(notifierSrc)) {
    throw new Error("Fonte do Notifier nao encontrada: " + notifierSrc);
  }
  const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
  if (!fs.existsSync(csc)) {
    throw new Error("Compilador C# nao encontrado: " + csc);
  }
  execSync(`"${csc}" /target:winexe /out:"${notifierExe}" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll "${notifierSrc}"`, {
    cwd: agentRoot,
    stdio: "inherit"
  });
  if (!fs.existsSync(notifierExe) || fs.statSync(notifierExe).size <= 0) {
    throw new Error("MonitorTI-Notifier.exe ausente ou vazio: " + notifierExe);
  }
  const notifierHash = crypto.createHash("sha256").update(fs.readFileSync(notifierExe)).digest("hex");
  console.log("Notifier gerado: " + notifierExe);
  console.log("Notifier tamanho: " + fs.statSync(notifierExe).size + " bytes");
  console.log("Notifier SHA256: " + notifierHash);

  const versionMatch = String(agentPackage.version || "").match(/^(\d+\.\d+\.\d+)/);
  if (!versionMatch) throw new Error("Versao do Agent invalida: " + agentPackage.version);
  const installerVersion = versionMatch[1];
  console.log("Versao do installer: " + installerVersion + " (agent/package.json)");

  // 2) garante o WinSW
  await ensureWinSW();

  // 3) localiza o Inno Setup Compiler
  const iscc = findISCC();
  if (!iscc) {
    throw new Error(
      "Inno Setup (ISCC.exe) nao encontrado. Instale Inno Setup 6 em " +
        "'C:\\Program Files (x86)\\Inno Setup 6' ou adicione ao PATH."
    );
  }
  console.log("ISCC: " + iscc);

  // 4) gera o helper da task companion a partir da fonte única.
  const taskHelperPath = path.join(installerDir, "notifier-companion-task.ps1");
  fs.writeFileSync(taskHelperPath, task.buildPowerShellScript(), "utf8");
  console.log("Task helper gerado: " + taskHelperPath);

  // 5) compila o instalador
  fs.mkdirSync(outDir, { recursive: true });
  execSync(`"${iscc}" "${issFile}" /DMyAppVersion=${installerVersion} /DMyAppSourceDir=${releaseDirName} /O"${outDir}"`, {
    cwd: installerDir,
    stdio: "inherit"
  });

  const setup = path.join(outDir, "HenriTech-Control-Agent-Setup-" + installerVersion + ".exe");
  if (!fs.existsSync(setup)) {
    throw new Error("Instalador nao foi gerado: " + setup);
  }
  const size = fs.statSync(setup).size;
  console.log("Instalador gerado: " + setup + " (" + size + " bytes)");
  console.log("Instalador SHA256: " + crypto.createHash("sha256").update(fs.readFileSync(setup)).digest("hex"));
}

main().catch((e) => {
  console.error("ERRO no build do instalador: " + e.message);
  process.exit(1);
});
