import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = path.join(root, "dist");
const agentPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rel = String(agentPackage.version).endsWith("-dev")
  ? path.join(root, "..", "release", "agent-dev-" + String(agentPackage.version).replace(/-dev$/, ""))
  : path.join(root, "..", "release", "agent-" + String(agentPackage.version));

fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(rel, { recursive: true });

// 1) bundle do agent (ws + check-disk-space embutidos)
await build({
  entryPoints: [path.join(root, "src", "index.js")],
  bundle: true,
  platform: "node",
  target: "node24",
  outfile: path.join(dist, "agent.bundle.js")
});

const bundleText = fs.readFileSync(path.join(dist, "agent.bundle.js"), "utf8");
for (const marker of ["function createConnectionLifecycle", "handshakeTimeoutMs", "livenessTimeoutMs"]) {
  if (!bundleText.includes(marker)) throw new Error(`Bundle invalido: marcador ausente: ${marker}`);
}

// 2) gera o blob SEA (Single Executable Application)
execSync("node --experimental-sea-config sea-config.json", {
  cwd: root,
  stdio: "inherit"
});

// 3) copia o Node 24 como base do executavel
fs.copyFileSync(process.execPath, path.join(rel, "MonitorTI-Agent.exe"));

// 4) injeta o blob no executavel
execSync(
  `npx postject "${path.join(rel, "MonitorTI-Agent.exe")}" NODE_SEA_BLOB ` +
    `"${path.join(dist, "sea-prep.blob")}" ` +
    `--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
  { cwd: root, stdio: "inherit" }
);

// 5) arquivos de apoio
fs.copyFileSync(path.join(root, "config.json"), path.join(rel, "config.json"));
fs.copyFileSync(path.join(root, "..", "installer", "notifier-companion-task.ps1"), path.join(rel, "notifier-companion-task.ps1"));
fs.copyFileSync(path.join(root, "..", "installer", "notifier-toast-identity.ps1"), path.join(rel, "notifier-toast-identity.ps1"));
if (fs.existsSync(path.join(root, "LEIA-ME.txt"))) {
  fs.copyFileSync(path.join(root, "LEIA-ME.txt"), path.join(rel, "LEIA-ME.txt"));
}

// 6) Notifier (C# WinForms compilado com o csc embutido do .NET Framework; sem instalacao)
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const notifierSrc = path.join(root, "..", "notifier", "MonitorTI-Notifier.cs");
const notifierOut = path.join(rel, "MonitorTI-Notifier.exe");
if (fs.existsSync(csc) && fs.existsSync(notifierSrc)) {
    execSync(`"${csc}" /target:winexe /out:"${notifierOut}" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll "${notifierSrc}"`, {
    cwd: root,
    stdio: "inherit"
  });
} else {
  throw new Error("csc ou fonte do Notifier ausente; pacote do piloto incompleto.");
}

const notifierBytes = fs.readFileSync(notifierOut);
fs.writeFileSync(path.join(rel, "notifier-integrity.json"), JSON.stringify({
  version: agentPackage.version,
  notifierSha256: crypto.createHash("sha256").update(notifierBytes).digest("hex"),
  notifierSize: notifierBytes.length
}, null, 2));

for (const name of [
  "notifier-companion-task.ps1",
  "notifier-toast-identity.ps1",
  "install-certificate-notification-pilot-v6.ps1",
  "rollback-certificate-notification-pilot-v6.ps1",
  "set-certificate-toast-pilot-flag-v6.ps1",
  "collect-pilot-status-v6.ps1"
]) {
  fs.copyFileSync(path.join(root, "..", "installer", name), path.join(rel, name));
}

const manifestNames = [
  "MonitorTI-Agent.exe",
  "MonitorTI-Notifier.exe",
  "config.json",
  "notifier-companion-task.ps1",
  "notifier-toast-identity.ps1",
  "LEIA-ME.txt",
  "notifier-integrity.json",
  "install-certificate-notification-pilot-v6.ps1",
  "rollback-certificate-notification-pilot-v6.ps1",
  "set-certificate-toast-pilot-flag-v6.ps1",
  "collect-pilot-status-v6.ps1"
];
const artifacts = Object.fromEntries(manifestNames.map((name) => {
  const file = fs.readFileSync(path.join(rel, name));
  return [name, {
    size: file.length,
    sha256: crypto.createHash("sha256").update(file).digest("hex")
  }];
}));
fs.writeFileSync(path.join(rel, "manifest-pilot.json"), JSON.stringify({
  schemaVersion: 1,
  packageRevision: "6.1",
  purpose: "LOCAL_REVIEW_ONLY",
  artifacts
}, null, 2) + "\n");

console.log("Build concluido: " + path.join(rel, "MonitorTI-Agent.exe"));
