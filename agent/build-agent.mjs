import { build } from "esbuild";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = path.join(root, "dist");
const rel = path.join(root, "..", "release", "agent-test");

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
if (fs.existsSync(path.join(root, "LEIA-ME.txt"))) {
  fs.copyFileSync(path.join(root, "LEIA-ME.txt"), path.join(rel, "LEIA-ME.txt"));
}

// 6) Notifier (C# WinForms compilado com o csc embutido do .NET Framework; sem instalacao)
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const notifierSrc = path.join(root, "..", "notifier", "MonitorTI-Notifier.cs");
const notifierOut = path.join(rel, "MonitorTI-Notifier.exe");
if (fs.existsSync(csc) && fs.existsSync(notifierSrc)) {
  execSync(`"${csc}" /target:winexe /out:"${notifierOut}" "${notifierSrc}"`, {
    cwd: root,
    stdio: "inherit"
  });
} else {
  console.warn("csc ou fonte do Notifier ausente; pulando compilacao do Notifier.");
}

console.log("Build concluido: " + path.join(rel, "MonitorTI-Agent.exe"));
