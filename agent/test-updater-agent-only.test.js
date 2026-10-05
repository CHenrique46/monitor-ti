const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const updater = require("./src/updater");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeAgentOnlyPackage(withResidue = false) {
  const dir = tempDir("mti-agent-only-");
  const agent = Buffer.from("AGENT-1.1.29");
  fs.writeFileSync(path.join(dir, "MonitorTI-Agent.exe"), agent);
  fs.writeFileSync(path.join(dir, "package-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    version: "1.1.29",
    packageMode: "agent-only",
    files: [{ name: "MonitorTI-Agent.exe", sha256: crypto.createHash("sha256").update(agent).digest("hex"), size: agent.length }],
    notifierAction: "preserve",
    configAction: "preserve",
    serviceAction: "restart"
  }));
  if (withResidue) fs.writeFileSync(path.join(dir, "MonitorTI-Notifier.exe"), "STALE");
  return dir;
}

test("Agent-only usa um único arquivo e ignora resíduo físico", () => {
  const install = path.join(tempDir("mti-agent-only-install-"), "MonitorTI-Agent.exe");
  const packageDir = makeAgentOnlyPackage(false);
  const parsed = updater.parseApplyUpdatePackageArgs(["node", "x", "--apply-update-package", packageDir, install, "MonitorTIAgent"]);
  assert.equal(parsed.packageMode, "agent-only");
  assert.deepEqual(parsed.files.map((f) => path.basename(f.dst)), ["MonitorTI-Agent.exe"]);
  const withResidue = updater.parseApplyUpdatePackageArgs(["node", "x", "--apply-update-package", makeAgentOnlyPackage(true), install, "MonitorTIAgent"]);
  assert.deepEqual(withResidue.files.map((f) => path.basename(f.dst)), ["MonitorTI-Agent.exe"]);
  const badManifestDir = makeAgentOnlyPackage(false);
  const badManifestPath = path.join(badManifestDir, "package-manifest.json");
  const badManifest = JSON.parse(fs.readFileSync(badManifestPath, "utf8"));
  badManifest.files.push({ name: "MonitorTI-Notifier.exe", sha256: "0".repeat(64), size: 1 });
  fs.writeFileSync(badManifestPath, JSON.stringify(badManifest));
  assert.throws(() => updater.parseApplyUpdatePackageArgs(["node", "x", "--apply-update-package", badManifestDir, install, "MonitorTIAgent"]), /allowlist/);
  const link = path.join(tempDir("mti-agent-only-link-"), "package");
  fs.symlinkSync(packageDir, link, "junction");
  assert.throws(() => updater.parseApplyUpdatePackageArgs(["node", "x", "--apply-update-package", link, install, "MonitorTIAgent"]), /reparse point|diretorio de pacote/);
});

test("leitor real usa sc.exe e reconhece Running pelo código 4", () => {
  const result = updater.queryServiceState("Spooler");
  assert.equal(result.stateCode, 4);
  assert.equal(result.state, "Running");
  assert.ok(Number.isInteger(result.processId));
});

test("fallback PowerShell preserva diagnóstico e dados estruturados", () => {
  const calls = [];
  const fakeExec = (file, args) => {
    calls.push(file);
    if (file.toLowerCase().endsWith("sc.exe")) throw Object.assign(new Error("sc failed"), { status: 7, stdout: "sc out", stderr: "sc err" });
    return '{"State":"Running","ProcessId":4321}';
  };
  const result = updater.queryServiceState("MonitorTIAgent", fakeExec);
  assert.equal(result.stateCode, 4);
  assert.equal(result.processId, 4321);
  assert.equal(calls.length, 2);
});

test("serviço inexistente retorna erro com exit code/stdout/stderr sanitizados", () => {
  assert.throws(() => updater.queryServiceState("MonitorTI-Service-Does-Not-Exist", () => {
    throw Object.assign(new Error("falha\nreal"), { status: 1060, stdout: "out\n", stderr: "err\n" });
  }), /exitCode=1060.*stdout=.*stderr=/);
});

test("StartPending evolui para Running no leitor injetado", () => {
  let now = 0;
  const result = updater.waitForServiceRunning("MonitorTIAgent", {
    getInfo: () => now < 500 ? { state: "StartPending", stateCode: 2, processId: 0 } : { state: "Running", stateCode: 4, processId: 123 },
    now: () => now,
    sleepImpl: (ms) => { now += ms; },
    pollIntervalMs: 250,
    timeoutMs: 1000
  });
  assert.equal(result.running, true);
  assert.equal(result.attempts, 3);
});

test("EBUSY no rollback cria marker e não declara restauração concluída", async () => {
  const installDir = tempDir("mti-ebusy-install-");
  const installExe = path.join(installDir, "MonitorTI-Agent.exe");
  fs.writeFileSync(installExe, "OLD_AGENT");
  const packageDir = makeAgentOnlyPackage(false);
  let unlockedCalls = 0;
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error("TEST_EXIT_" + code); };
  try {
    await assert.rejects(() => updater.run([
      "node", "x", "--apply-update-package", packageDir, installExe, "MonitorTIAgent"
    ], {
      execFileSync: () => "",
      queryServiceState: () => ({ state: "Stopped", stateCode: 1, processId: 0 }),
      isFileUnlocked: () => unlockedCalls++ === 0,
      sleep: () => {}
    }), /TEST_EXIT_1/);
  } finally {
    process.exit = originalExit;
  }
  const marker = JSON.parse(fs.readFileSync(installExe + ".recovery.json", "utf8"));
  assert.equal(marker.rollbackCompleted, false);
  assert.match(marker.restoreFailure.error, /EBUSY/);
  assert.equal(fs.readFileSync(installExe, "utf8"), "OLD_AGENT");
});
