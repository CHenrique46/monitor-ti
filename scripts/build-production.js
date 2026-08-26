const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const dashboardDir = path.join(repoRoot, "dashboard");
const agentTestDir = path.join(repoRoot, "release", "agent-test");
const installerDir = path.join(repoRoot, "installer");

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(" ")} (cwd: ${cwd})`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true });
  if (result.status !== 0) {
    console.error(`Falha ao executar: ${command} ${args.join(" ")}`);
    process.exit(result.status || 1);
  }
}

console.log("=== Monitor TI: build de producao ===");

if (!fs.existsSync(dashboardDir)) {
  console.error("Diretorio do dashboard nao encontrado:", dashboardDir);
  process.exit(1);
}

run("npm", ["install"], dashboardDir);
run("npm", ["run", "build"], dashboardDir);

const distIndex = path.join(dashboardDir, "dist", "index.html");
if (!fs.existsSync(distIndex)) {
  console.error("Dashboard nao foi compilado. Esperado:", distIndex);
  process.exit(1);
}
console.log("Dashboard compilado:", distIndex);

if (!fs.existsSync(agentTestDir)) {
  fs.mkdirSync(agentTestDir, { recursive: true });
}

const winswSrc = path.join(agentTestDir, "WinSW.exe");
if (!fs.existsSync(winswSrc)) {
  console.error(
    "WinSW.exe nao encontrado em release/agent-test. Copie o WinSW v2.12.0 (build .NET Framework, x64) para release/agent-test/WinSW.exe."
  );
  process.exit(1);
}

fs.copyFileSync(winswSrc, path.join(agentTestDir, "MonitorTIServer.exe"));
fs.copyFileSync(
  path.join(installerDir, "MonitorTIServer.xml"),
  path.join(agentTestDir, "MonitorTIServer.xml")
);

console.log("\nArquivos do servico de producao preparados em release/agent-test:");
console.log("  - MonitorTIServer.exe (wrapper WinSW)");
console.log("  - MonitorTIServer.xml (configuracao do servico)");

console.log("\nProximos passos (requer permissao de Administrador):");
console.log("  1. Iniciar o servidor manualmente para teste:");
console.log("       cd server && npm start");
console.log("  2. Abrir http://localhost:4000 (dashboard em producao)");
console.log("  3. Instalar como servico Windows:");
console.log("       powershell -ExecutionPolicy Bypass -File installer/install-server-service.ps1");
console.log("  4. Validar com scripts de teste e reinicializar o Windows (Teste 21).");
