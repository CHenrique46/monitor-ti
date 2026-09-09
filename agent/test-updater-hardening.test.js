const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const updater = require("./src/updater");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runInTest(argv, deps = {}) {
  const originalExit = process.exit;
  const originalMode = process.env.MTI_UPDATER_TEST;
  let exitCode = null;
  process.env.MTI_UPDATER_TEST = "1";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("TEST_EXIT_" + code);
  };
  try {
    await assert.rejects(() => updater.run(argv, {
      execFileSync: () => "",
      createOrUpdateTask: () => "mocked",
      queryTaskXml: () => null,
      restoreTaskXml: () => {},
      removeTask: () => {},
      runTask: () => {},
      hasInteractiveSession: () => false,
      ...deps
    }), /TEST_EXIT_/);
  } finally {
    process.exit = originalExit;
    if (originalMode === undefined) delete process.env.MTI_UPDATER_TEST;
    else process.env.MTI_UPDATER_TEST = originalMode;
  }
  return exitCode;
}

function makePackage() {
  const dir = tempDir("mti-updater-hardening-pkg-");
  fs.writeFileSync(path.join(dir, "MonitorTI-Agent.exe"), "NEW_AGENT");
  fs.writeFileSync(path.join(dir, "MonitorTI-Notifier.exe"), "NEW_NOTIFIER");
  fs.writeFileSync(path.join(dir, "notifier-integrity.json"), "NEW_INTEGRITY");
  return dir;
}

test("updater cria backups e conclui troca sem serviço real", async () => {
  const installDir = tempDir("mti-updater-hardening-install-");
  const installExe = path.join(installDir, "MonitorTI-Agent.exe");
  const notifierExe = path.join(installDir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, "OLD_AGENT");
  fs.writeFileSync(notifierExe, "OLD_NOTIFIER");
  const code = await runInTest(["node", "x", "--apply-update-package", makePackage(), installExe, "MonitorTIAgent"]);
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(installExe, "utf8"), "NEW_AGENT");
  assert.equal(fs.readFileSync(notifierExe, "utf8"), "NEW_NOTIFIER");
  assert.equal(fs.readFileSync(installExe + ".previous", "utf8"), "OLD_AGENT");
  assert.equal(fs.readFileSync(notifierExe + ".previous", "utf8"), "OLD_NOTIFIER");
});

test("falha de substituição restaura todos os arquivos e retorna falha", async () => {
  const installDir = tempDir("mti-updater-hardening-rollback-");
  const installExe = path.join(installDir, "MonitorTI-Agent.exe");
  const notifierExe = path.join(installDir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, "OLD_AGENT");
  fs.writeFileSync(notifierExe, "OLD_NOTIFIER");
  const packageDir = makePackage();
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (source, destination) => {
    if (source === path.join(packageDir, "MonitorTI-Notifier.exe")) throw new Error("copy failure");
    return originalCopy(source, destination);
  };
  try {
    const code = await runInTest(["node", "x", "--apply-update-package", packageDir, installExe, "MonitorTIAgent"]);
    assert.equal(code, 1);
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.equal(fs.readFileSync(installExe, "utf8"), "OLD_AGENT");
  assert.equal(fs.readFileSync(notifierExe, "utf8"), "OLD_NOTIFIER");
});
