const fs = require("fs");
const os = require("os");
const path = require("path");
const updater = require("../agent/src/updater");
const crypto = require("crypto");
const { version: AGENT_VERSION } = require("../agent/package.json");

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

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkInstallDir(prefix) {
  const dir = tempDir(prefix);
  const installExe = path.join(dir, "MonitorTI-Agent.exe");
  const notifierExe = path.join(dir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, "ORIGINAL-AGENT-BINARY");
  fs.writeFileSync(notifierExe, "ORIGINAL-NOTIFIER-BINARY");
  return { dir, installExe, notifierExe };
}

function mkPackageDir() {
  return path.join(__dirname, "..", "releases", "agent", AGENT_VERSION);
}

function runUpdater(argv, options = {}) {
  const originalExit = process.exit;
  const originalCopy = fs.copyFileSync;
  const originalEnv = process.env.MTI_UPDATER_TEST;
  let exitCode = null;
  let threw = null;

  process.env.MTI_UPDATER_TEST = "1";
  process.exit = (code) => {
    exitCode = code;
    const err = new Error("EXIT:" + code);
    err.exitCode = code;
    throw err;
  };

  if (options.patchCopy) {
    fs.copyFileSync = options.patchCopy(originalCopy);
  }

  const calls = [];
  const execFileSync = (cmd, args, opts) => {
    calls.push({ cmd, args: Array.from(args || []), opts });
    const joined = args.join(" ");
    if (cmd.toLowerCase().includes("powershell")) {
      const modeIndex = args.findIndex((a) => String(a).toLowerCase() === "-mode");
      const mode = modeIndex >= 0 ? String(args[modeIndex + 1] || "") : "";
      if (mode === "install" && options.failCreateTask) {
        const err = new Error("task create fail");
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (mode === "run" && options.failRunTask) {
        const err = new Error("task run fail");
        err.status = 1;
        err.stdout = "";
        err.stderr = "";
        throw err;
      }
      if (mode === "remove") {
        return "";
      }
      if (mode === "queryxml") {
        return options.taskSnapshotXml || "";
      }
      if (mode === "state") {
        return options.taskStateJson || JSON.stringify(options.taskSnapshotXml ? { exists: true } : { exists: false });
      }
      return options.taskPowerShellOutput || (mode === "install" ? "created" : "");
    }
    if (cmd.toLowerCase().includes("schtasks")) {
      if (joined.includes("/create") && options.failRestoreTask) throw new Error("task restore fail");
      if (joined.includes("/delete") && options.failDeleteTask) throw new Error("task delete fail");
      return "";
    }
    if (cmd.toLowerCase().includes("net")) {
      return "";
    }
    if (cmd.toLowerCase().includes("taskkill")) {
      return "";
    }
    return "";
  };

  try {
    updater.run(argv, {
      execFileSync,
      createOrUpdateTask: () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Mode", "install"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      queryTaskXml: () => options.taskSnapshotXml || null,
      runTask: () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Mode", "run"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      removeTask: () => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Mode", "remove"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      restoreTaskXml: (xml) => execFileSync("schtasks.exe", ["/create", "/xml", "C:\\Temp\\restore.xml", "/tn", "MonitorTI-Notifier", "/f"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      hasInteractiveSession: () => options.interactiveUser !== null && options.interactiveUser !== undefined && String(options.interactiveUser).trim() !== "",
      allowTaskRunInTestMode: true
    });
  } catch (e) {
    threw = e;
  } finally {
    process.exit = originalExit;
    fs.copyFileSync = originalCopy;
    if (originalEnv === undefined) delete process.env.MTI_UPDATER_TEST; else process.env.MTI_UPDATER_TEST = originalEnv;
  }

  return { exitCode, threw, calls };
}

function makePackageSandbox() {
  const pkg = mkPackageDir();
  const dir = tempDir("mti-update-task-");
  fs.copyFileSync(path.join(pkg, "MonitorTI-Agent.exe"), path.join(dir, "MonitorTI-Agent.exe"));
  fs.copyFileSync(path.join(pkg, "MonitorTI-Notifier.exe"), path.join(dir, "MonitorTI-Notifier.exe"));
  fs.copyFileSync(path.join(pkg, "manifest.json"), path.join(dir, "manifest.json"));
  return dir;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function main() {
  // UPDATE-TASK-001 task ausente -> criada.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-1-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-001 task ausente criada", r.exitCode === 0 && r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("install")));
  }

  // UPDATE-TASK-002 task correta -> idempotente.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-2-");
    const snapshot = "<Task><Actions/></Task>";
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      taskSnapshotXml: snapshot,
      interactiveUser: "Henrique"
    });
    const creates = r.calls.filter((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("install"));
    check("UPDATE-TASK-002 task correta idempotente", r.exitCode === 0 && creates.length >= 1);
  }

  // UPDATE-TASK-003 task incorreta -> corrigida.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-3-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      taskSnapshotXml: "<Task><Actions><Exec><Command>old.exe</Command></Exec></Actions></Task>",
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-003 task incorreta corrigida", r.exitCode === 0 && r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("install")));
  }

  // UPDATE-TASK-004 ensure task falha -> update falha controladamente.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-4-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      failCreateTask: true,
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-004 ensure task falha", r.exitCode === 1);
  }

  // UPDATE-TASK-005 task criada + falha posterior -> rollback remove task nova.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-5-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      failRunTask: true,
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-005 rollback remove task nova", r.exitCode === 1 && r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("remove")));
  }

  // UPDATE-TASK-006 task pré-existente preservada em rollback.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-6-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      taskSnapshotXml: "<Task><Actions><Exec><Command>old.exe</Command></Exec></Actions></Task>",
      failRunTask: true,
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-006 rollback preserva task previa", r.exitCode === 1 && r.calls.some((c) => c.cmd.toLowerCase().includes("schtasks") && c.args.includes("/create") && c.args.includes("/xml")));
  }

  // UPDATE-TASK-007 sessão ativa -> task Run após update.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-7-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-007 task Run após update", r.exitCode === 0 && r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("run")));
  }

  // UPDATE-TASK-008 sem sessão -> task existe, mas não Run.
  {
    const pkg = makePackageSandbox();
    const installBase = mkInstallDir("mti-update-task-install-8-");
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, installBase.installExe, "MonitorTIAgent"], {
      interactiveUser: null
    });
    check("UPDATE-TASK-008 sem sessão sem run", r.exitCode === 0 && !r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("run")));
  }

  // UPDATE-TASK-009 1.1.6 -> versao atual completo com task ausente.
  {
    const pkg = makePackageSandbox();
    const t = mkInstallDir("mti-update-task-legacy-");
    const expectedAgent = sha256(path.join(pkg, "MonitorTI-Agent.exe"));
    const expectedNotifier = sha256(path.join(pkg, "MonitorTI-Notifier.exe"));
    const r = runUpdater(["node", "x", "--apply-update-package", pkg, t.installExe, "MonitorTIAgent"], {
      interactiveUser: "Henrique"
    });
    check("UPDATE-TASK-009 1.1.6->" + AGENT_VERSION + " task ausente completo", r.exitCode === 0 && sha256(t.installExe) === expectedAgent && sha256(t.notifierExe) === expectedNotifier && r.calls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("install")));
  }

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();
