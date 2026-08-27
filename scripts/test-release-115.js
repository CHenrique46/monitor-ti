const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const updater = require("../agent/src/updater");
const releases = require("../server/src/services/releases.service");
const { buildUpdateCommand } = require("../server/src/services/updateCommand");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function mkTempInstallDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const installExe = path.join(dir, "MonitorTI-Agent.exe");
  const notifierExe = path.join(dir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, Buffer.from("ORIGINAL-AGENT-BINARY"));
  fs.writeFileSync(notifierExe, Buffer.from("ORIGINAL-NOTIFIER-BINARY"));
  return { dir, installExe, notifierExe };
}

function mkPackageSandbox() {
  const src = path.join(__dirname, "..", "release", "agent-test");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mti-115-pkg-"));
  fs.copyFileSync(path.join(src, "MonitorTI-Agent.exe"), path.join(dir, "MonitorTI-Agent.exe"));
  fs.copyFileSync(path.join(src, "MonitorTI-Notifier.exe"), path.join(dir, "MonitorTI-Notifier.exe"));
  return dir;
}

function runUpdater(argv, patchCopy) {
  const originalExit = process.exit;
  const originalCopy = fs.copyFileSync;
  const originalTestMode = process.env.MTI_UPDATER_TEST;
  let exitCode = null;
  let threw = null;

  process.env.MTI_UPDATER_TEST = "1";
  process.exit = (code) => {
    exitCode = code;
    const err = new Error("EXIT:" + code);
    err.exitCode = code;
    throw err;
  };

  if (patchCopy) {
    fs.copyFileSync = patchCopy(originalCopy);
  }

  try {
    updater.run(argv);
  } catch (e) {
    threw = e;
  } finally {
    process.exit = originalExit;
    fs.copyFileSync = originalCopy;
    if (originalTestMode === undefined) delete process.env.MTI_UPDATER_TEST;
    else process.env.MTI_UPDATER_TEST = originalTestMode;
  }

  return { exitCode, threw };
}

(async () => {
  const rel = await releases.getRelease("1.1.5");
  const pub = releases.toPublic(rel);
  const releaseRoot = path.join(__dirname, "..", "releases", "agent", "1.1.5");
  const zipPath = path.join(releaseRoot, pub.packageName);
  const pkgDir = mkPackageSandbox();
  const agentPkg = path.join(pkgDir, "MonitorTI-Agent.exe");
  const notifierPkg = path.join(pkgDir, "MonitorTI-Notifier.exe");

  check("release 1.1.5 existe", !!rel);
  check("release 1.1.5 inativa", !rel.active);
  check("package presente", !!pub.packageName && !!pub.packageSha256 && pub.packageSize > 0);
  check("manifest com 2 arquivos", Array.isArray(pub.manifest.files) && pub.manifest.files.length === 2);
  check("package sha atual", sha256File(zipPath).toLowerCase() === String(pub.packageSha256).toLowerCase());
  check("agent sha pacote", sha256File(agentPkg).toLowerCase() === String(pub.sha256).toLowerCase());
  const notifEntry = pub.manifest.files.find((f) => f.name === "MonitorTI-Notifier.exe");
  check("notifier sha pacote", sha256File(notifierPkg).toLowerCase() === String(notifEntry.sha256).toLowerCase());
  const cmd = buildUpdateCommand("1.1.4", rel);
  check("1.1.4 usa package mode", cmd.package === true && cmd.sha256 === pub.packageSha256 && cmd.notifierSha256 === notifEntry.sha256);

  // Sucesso: aplica pacote em sandbox e mantém backups.
  {
    const pkg = mkPackageSandbox();
    const t = mkTempInstallDir("mti-115-ok-");
    const argv = ["node", "x", "--apply-update-package", pkg, t.installExe, "MonitorTIAgent"];
    const r = runUpdater(argv, null);
    check("sucesso exit 0", r.exitCode === 0, r.threw && r.threw.message);
    check("sucesso agent trocado", sha256File(t.installExe).toLowerCase() === String(pub.sha256).toLowerCase());
    check("sucesso notifier trocado", sha256File(t.notifierExe).toLowerCase() === String(notifEntry.sha256).toLowerCase());
    check("backup agent criado", fs.existsSync(t.installExe + ".previous"));
    check("backup notifier criado", fs.existsSync(t.notifierExe + ".previous"));
    check("backup agent preserva original", sha256File(t.installExe + ".previous").toLowerCase() !== String(pub.sha256).toLowerCase());
  }

  // Rollback: falha no segundo copy deve restaurar o estado original.
  {
    const pkg = mkPackageSandbox();
    const t = mkTempInstallDir("mti-115-rb-");
    let copyCount = 0;
    const argv = ["node", "x", "--apply-update-package", pkg, t.installExe, "MonitorTIAgent"];
    const r = runUpdater(argv, (origCopy) => (src, dst) => {
      if (String(src).includes("MonitorTI-Notifier.exe") && String(dst).endsWith("MonitorTI-Notifier.exe")) {
        copyCount += 1;
        throw new Error("simulated copy failure");
      }
      return origCopy(src, dst);
    });
    check("rollback exit 1", r.exitCode === 1, r.threw && r.threw.message);
    check("rollback copiou agente ao menos uma vez", sha256File(t.installExe).toLowerCase() === sha256File(t.installExe + ".previous").toLowerCase() || fs.existsSync(t.installExe + ".previous"));
    check("rollback restaurou agent original", sha256File(t.installExe).toLowerCase() === crypto.createHash("sha256").update(Buffer.from("ORIGINAL-AGENT-BINARY")).digest("hex"));
    check("rollback restaurou notifier original", sha256File(t.notifierExe).toLowerCase() === crypto.createHash("sha256").update(Buffer.from("ORIGINAL-NOTIFIER-BINARY")).digest("hex"));
    check("rollback backup agent existe", fs.existsSync(t.installExe + ".previous"));
    check("rollback backup notifier existe", fs.existsSync(t.notifierExe + ".previous"));
    check("rollback patch acionado", copyCount >= 1);
  }

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("ERRO no teste:", e.stack || e.message);
  process.exit(1);
});
