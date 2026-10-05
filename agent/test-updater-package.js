const fs = require("fs");
const os = require("os");
const path = require("path");
const updater = require("./src/updater");

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

(async () => {
  const appDir = mkdtemp("mti-app-");
  const installExe = path.join(appDir, "MonitorTI-Agent.exe");
  const installNot = path.join(appDir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, "OLD_AGENT");
  fs.writeFileSync(installNot, "OLD_NOTIFIER");

  const pkgDir = mkdtemp("mti-pkg-");
  fs.writeFileSync(path.join(pkgDir, "MonitorTI-Agent.exe"), "NEW_AGENT_v111");
  fs.writeFileSync(path.join(pkgDir, "MonitorTI-Notifier.exe"), "NEW_NOTIFIER_v111");
  fs.writeFileSync(path.join(pkgDir, "notifier-integrity.json"), JSON.stringify({
    version: "1.1.0",
    notifierSha256: "local-test-hash"
  }));

  try {
    await updater.run(
      ["node", "src/updater.js", "--apply-update-package", pkgDir, installExe, "MonitorTIAgent"],
      {
        execFileSync: () => "",
        queryServiceState: () => ({ state: "Running", stateCode: 4, processId: 0 }),
        isFileUnlocked: () => true,
        sleep: () => {},
        queryTaskState: () => null,
        createOrUpdateTask: () => "test",
        queryTaskXml: () => null,
        restoreTaskXml: () => {},
        removeTask: () => {},
        runTask: () => {},
        queryNotifierProcesses: () => [],
        waitForNotifierExit: () => true,
        terminateNotifierProcess: () => {},
        disableTask: () => {},
        enableTask: () => {},
        hasInteractiveSession: () => false
      }
    );
    const agentNow = fs.readFileSync(installExe, "utf8");
    const notifNow = fs.readFileSync(installNot, "utf8");
    const integrityNow = fs.readFileSync(path.join(appDir, "notifier-integrity.json"), "utf8");
    const agentBak = fs.existsSync(installExe + ".previous");
    const notifBak = fs.existsSync(installNot + ".previous");

    let ok = true;
    if (agentNow !== "NEW_AGENT_v111") { console.error("FAIL: Agent nao trocado"); ok = false; }
    if (notifNow !== "NEW_NOTIFIER_v111") { console.error("FAIL: Notifier nao trocado"); ok = false; }
    if (!integrityNow.includes("local-test-hash")) { console.error("FAIL: metadata local nao trocada"); ok = false; }
    if (!agentBak) { console.error("FAIL: backup do Agent ausente"); ok = false; }
    if (!notifBak) { console.error("FAIL: backup do Notifier ausente"); ok = false; }
    if (ok) {
      console.log("PASS package-update: Agent+Notifier trocados com backup individual");
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (error) {
    console.error("UPDATER ERROR = " + error.message);
    process.exit(1);
  }
})();
