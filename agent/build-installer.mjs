import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = __dirname;
const repoRoot = path.join(agentRoot, "..");
const installerDir = path.join(repoRoot, "installer");
const releaseAgentTest = path.join(repoRoot, "release", "agent-test");
const outDir = path.join(repoRoot, "release", "installer-test");
const agentExe = path.join(releaseAgentTest, "MonitorTI-Agent.exe");
const winswExe = path.join(releaseAgentTest, "WinSW.exe");
const issFile = path.join(installerDir, "MonitorTI-Agent.iss");

const WINSW_URL =
  "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe";

function findISCC() {
  const fixed = [
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

  // 4) compila o instalador
  fs.mkdirSync(outDir, { recursive: true });
  execSync(`"${iscc}" "${issFile}" /O"${outDir}"`, {
    cwd: installerDir,
    stdio: "inherit"
  });

  const setup = path.join(outDir, "MonitorTI-Agent-Setup.exe");
  if (!fs.existsSync(setup)) {
    throw new Error("Instalador nao foi gerado: " + setup);
  }
  const size = fs.statSync(setup).size;
  console.log("Instalador gerado: " + setup + " (" + size + " bytes)");
}

main().catch((e) => {
  console.error("ERRO no build do instalador: " + e.message);
  process.exit(1);
});
