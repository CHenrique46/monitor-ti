// Teste ISOLADO do bootstrap 1.0.1 -> 1.1.0 (sem deploy, sem servidor real).
// Valida especialmente o cenário de FALHA de ensureNotifierPresent:
//  - rede indisponível
//  - SHA do Notifier divergente
// O Agent NÃO deve crashar, NÃO deve gerar novo deviceId, e deve continuar
// funcional (apenas sem a funcionalidade de avisos).
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createNotifier } = require("./src/notifier");

const AGENT_STANDIN = process.execPath; // qualquer binário serve de stand-in p/ Agent

// Em máquina de dev, release/agent-test/MonitorTI-Notifier.exe existe e faz
// findNotifierExe short-circuitar. Removemos temporariamente (artefato gitignored)
// para exercitar o caminho de "Notifier ausente" de forma isolada.
const REAL = path.join(__dirname, "..", "release", "agent-test", "MonitorTI-Notifier.exe");
let moved = false;
if (fs.existsSync(REAL)) {
  fs.renameSync(REAL, REAL + ".bak");
  moved = true;
}
process.on("exit", () => { try { if (moved) fs.renameSync(REAL + ".bak", REAL); } catch (e) {} });

function buildPackage(outDir, tamper) {
  fs.mkdirSync(outDir, { recursive: true });
  const agentBuf = fs.readFileSync(AGENT_STANDIN);
  const notifBuf = Buffer.from("FAKE-NOTIFIER-BINARY");
  const agentSha = crypto.createHash("sha256").update(agentBuf).digest("hex");
  const realNotifSha = crypto.createHash("sha256").update(notifBuf).digest("hex");
  const notifSha = tamper ? "00".repeat(32) : realNotifSha;
  const agentName = "MonitorTI-Agent.exe";
  const notifName = "MonitorTI-Notifier.exe";
  fs.writeFileSync(path.join(outDir, agentName), agentBuf);
  fs.writeFileSync(path.join(outDir, notifName), notifBuf);
  const manifest = {
    version: "1.1.0",
    files: [
      { name: agentName, sha256: agentSha, size: agentBuf.length },
      { name: notifName, sha256: notifSha, size: notifBuf.length }
    ]
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(outDir, "notifier-integrity.json"), JSON.stringify({ version: "1.1.0", notifierSha256: realNotifSha, notifierSize: notifBuf.length }));
  const zipPath = path.join(outDir, "pkg.zip");
  const r = spawnSync("tar", ["-a", "-cf", zipPath, "-C", outDir, agentName, notifName, "manifest.json"], { windowsHide: true });
  if (r.status !== 0) throw new Error("tar zip failed: " + (r.stderr || "").toString());
  return { zipPath, zipSha: crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex"), tamper };
}

function makeNotifier(appDir, baseUrl) {
  const logs = [];
  const n = createNotifier({
    configDir: path.join(appDir, "cfg"),
    getAppDir: () => appDir,
    getDeviceId: () => "TEST-DEVICE-ID-STABLE",
    getWs: () => null,
    logEvent: (m) => logs.push(m),
    version: "1.1.0",
    getServerHttpBase: () => baseUrl
  });
  return { n, logs };
}

function startServer(pkg) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
       if (!req.url.includes("/package")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          version: "1.1.0",
          packageName: "pkg.zip",
           packageSha256: pkg.zipSha,
           packageSize: fs.statSync(pkg.zipPath).size,
           manifest: { version: "1.1.0", files: [{ name: "MonitorTI-Notifier.exe", sha256: pkg.tamper ? "00".repeat(32) : crypto.createHash("sha256").update(Buffer.from("FAKE-NOTIFIER-BINARY")).digest("hex") }] }
        }));
        return;
      }
      if (req.url.includes("/package")) {
        res.setHeader("content-type", "application/octet-stream");
        res.end(fs.readFileSync(pkg.zipPath));
        return;
      }
      res.statusCode = 404; res.end();
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(name, fn) {
  try { await fn(); console.log("PASS " + name); }
  catch (e) { console.log("FAIL " + name + " :: " + e.message); process.exitCode = 1; }
}

(async () => {
  // 1) Notifier já presente -> não tenta baixar, não crasha.
  await scenario("present: short-circuit sem download", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-present-"));
    fs.writeFileSync(path.join(dir, "MonitorTI-Notifier.exe"), Buffer.from("x"));
    fs.writeFileSync(path.join(dir, "notifier-integrity.json"), JSON.stringify({ version: "1.1.0", notifierSha256: crypto.createHash("sha256").update(Buffer.from("x")).digest("hex") }));
    const { n, logs } = makeNotifier(dir, "http://127.0.0.1:1");
    if (!n.isNotifierReady()) throw new Error("Notifier local deveria estar pronto: " + logs.join(" | "));
  });

  // 2) Rede indisponível -> erro logado, processo continua, sem crash.
  await scenario("failure: rede indisponível", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-net-"));
    const { n, logs } = makeNotifier(dir, "http://127.0.0.1:1");
    n.ensureNotifierPresent();
    await wait(1500);
    const errLogged = logs.some((l) => /falha ao obter Notifier/.test(l) || /aviso:/.test(l));
    const installed = fs.existsSync(path.join(dir, "MonitorTI-Notifier.exe"));
    if (!errLogged) throw new Error("erro nao logado: " + logs.join(" | "));
    if (installed) throw new Error("nao deveria instalar Notifier com rede falha");
  });

  // 3) SHA do Notifier divergente -> erro logado, não instala, não crasha.
  await scenario("failure: SHA do Notifier invalido", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-sha-"));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-sha-pkg-"));
    const pkg = buildPackage(pkgDir, true); // tamper=true -> sha errado no manifest
    const srv = await startServer(pkg);
    const port = srv.address().port;
    const { n, logs } = makeNotifier(dir, "http://127.0.0.1:" + port);
    n.ensureNotifierPresent();
     await wait(5000);
    const shaErr = logs.some((l) => /SHA/.test(l));
    const installed = fs.existsSync(path.join(dir, "MonitorTI-Notifier.exe"));
    srv.close();
    if (!shaErr) throw new Error("erro de SHA nao logado: " + logs.join(" | "));
    if (installed) throw new Error("nao deveria instalar Notifier com SHA invalido");
  });

  // 4) Sucesso: baixa pacote correto, valida SHA e instala Notifier.
  await scenario("success: instala Notifier validado", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ok-"));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ok-pkg-"));
    const pkg = buildPackage(pkgDir, false); // tamper=false -> sha correto
    const srv = await startServer(pkg);
    const port = srv.address().port;
    const { n, logs } = makeNotifier(dir, "http://127.0.0.1:" + port);
    n.ensureNotifierPresent();
     await wait(5000);
    srv.close();
    const installed = fs.existsSync(path.join(dir, "MonitorTI-Notifier.exe"));
    if (!installed) throw new Error("Notifier nao instalado: " + logs.join(" | "));
    if (!logs.some((l) => /obtido e validado/.test(l))) throw new Error("log de sucesso ausente: " + logs.join(" | "));
  });

  console.log("\nConcluido. exitCode=" + (process.exitCode || 0));
})();
