// Teste isolado da capability "notices" no Agent (notifier.js).
// Valida isNotifierReady e o callback onNotifierReady (disparado quando o
// Notifier é instalado com sucesso; NÃO disparado em falha). Sem deploy.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { createNotifier } = require("./src/notifier");

const AGENT_STANDIN = process.execPath;

// Em dev, release/agent-test/MonitorTI-Notifier.exe existe e faz findNotifierExe
// short-circuitar. Removemos temporariamente (artefato gitignored) para exercitar
// o caminho de "Notifier ausente".
const REAL = path.join(__dirname, "..", "release", "agent-test", "MonitorTI-Notifier.exe");
let moved = false;
if (fs.existsSync(REAL)) { fs.renameSync(REAL, REAL + ".bak"); moved = true; }
process.on("exit", () => { try { if (moved) fs.renameSync(REAL + ".bak", REAL); } catch (e) {} });

function buildPackage(outDir, tamper) {
  fs.mkdirSync(outDir, { recursive: true });
  const agentBuf = fs.readFileSync(AGENT_STANDIN);
  const notifBuf = Buffer.from("FAKE-NOTIFIER-BINARY");
  const agentSha = crypto.createHash("sha256").update(agentBuf).digest("hex");
  const realNotifSha = crypto.createHash("sha256").update(notifBuf).digest("hex");
  const notifSha = tamper ? "00".repeat(32) : realNotifSha;
  fs.writeFileSync(path.join(outDir, "MonitorTI-Agent.exe"), agentBuf);
  fs.writeFileSync(path.join(outDir, "MonitorTI-Notifier.exe"), notifBuf);
  const manifest = { version: "1.1.0", files: [
    { name: "MonitorTI-Agent.exe", sha256: agentSha, size: agentBuf.length },
    { name: "MonitorTI-Notifier.exe", sha256: notifSha, size: notifBuf.length }
  ] };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));
  const zipPath = path.join(outDir, "pkg.zip");
  spawnSync("tar", ["-a", "-cf", zipPath, "-C", outDir, "MonitorTI-Agent.exe", "MonitorTI-Notifier.exe", "manifest.json"], { windowsHide: true });
  return { zipPath, zipSha: crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex") };
}

function makeNotifier(appDir, baseUrl, onReady) {
  const logs = [];
  const n = createNotifier({
    configDir: path.join(appDir, "cfg"),
    getAppDir: () => appDir,
    getDeviceId: () => "TEST-DEV",
    getWs: () => null,
    logEvent: (m) => logs.push(m),
    version: "1.1.0",
    getServerHttpBase: () => baseUrl,
    onNotifierReady: onReady
  });
  return { n, logs };
}

function startServer(pkg) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url.endsWith("/latest")) {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ version: "1.1.0", packageName: "pkg.zip", packageSha256: pkg.zipSha, manifest: { files: [] } }));
      } else if (req.url.includes("/package")) {
        res.setHeader("content-type", "application/octet-stream");
        res.end(fs.readFileSync(pkg.zipPath));
      } else { res.statusCode = 404; res.end(); }
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(n, c, extra) { if (c) { pass++; console.log("PASS " + n); } else { fail++; console.log("FAIL " + n + (extra ? " :: " + extra : "")); } }

(async () => {
  // 1) isNotifierReady reflete presença
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), "cap-present-"));
  fs.writeFileSync(path.join(d1, "MonitorTI-Notifier.exe"), Buffer.from("x"));
  const { n: n1 } = makeNotifier(d1, "", () => {});
  check("isNotifierReady=true quando presente", n1.isNotifierReady() === true);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "cap-absent-"));
  const { n: n2 } = makeNotifier(d2, "", () => {});
  check("isNotifierReady=false quando ausente", n2.isNotifierReady() === false);

  // 2) sucesso -> onNotifierReady disparado
  let readyFired = false;
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "cap-ok-"));
  const pkg = buildPackage(fs.mkdtempSync(path.join(os.tmpdir(), "cap-ok-pkg-")), false);
  const srv = await startServer(pkg);
  const port = srv.address().port;
  const { n: n3, logs: l3 } = makeNotifier(d3, "http://127.0.0.1:" + port, () => { readyFired = true; });
  n3.ensureNotifierPresent();
  await wait(2500);
  srv.close();
  check("sucesso: onNotifierReady disparado", readyFired === true);
  check("sucesso: Notifier instalado", fs.existsSync(path.join(d3, "MonitorTI-Notifier.exe")));

  // 3) falha de rede -> onNotifierReady NÃO disparado, sem crash
  let readyFail = false;
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), "cap-fail-"));
  const { n: n4, logs: l4 } = makeNotifier(d4, "http://127.0.0.1:1", () => { readyFail = true; });
  n4.ensureNotifierPresent();
  await wait(1500);
  check("falha: onNotifierReady NÃO disparado", readyFail === false);
  check("falha: erro logado sem crash", l4.some((l) => /falha ao obter Notifier/.test(l)));

  console.log("\nCAPABILITY (agent): " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERRO", e); process.exit(1); });
