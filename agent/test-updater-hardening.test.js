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
  let exitCode = null;
  let serviceQueries = 0;
  process.exit = (code) => {
    exitCode = code;
    throw new Error("TEST_EXIT_" + code);
  };
  try {
    await assert.rejects(() => updater.run(argv, {
      execFileSync: () => "",
      queryServiceState: () => (++serviceQueries === 1
        ? { state: "Running", stateCode: 4, processId: 0 }
        : { state: "Stopped", stateCode: 1, processId: 0 }),
      isFileUnlocked: () => true,
      sleep: () => {},
      queryTaskState: () => null,
      createOrUpdateTask: () => "mocked",
      queryTaskXml: () => null,
      restoreTaskXml: () => {},
      removeTask: () => {},
      runTask: () => {},
      queryNotifierProcesses: () => [],
      waitForNotifierExit: () => true,
      terminateNotifierProcess: () => {},
      disableTask: () => {},
      enableTask: () => {},
      hasInteractiveSession: () => false,
      ...deps
    }), /TEST_EXIT_/);
  } finally {
    process.exit = originalExit;
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

function controlledDeps(overrides = {}) {
  const events = [];
  return {
    events,
    queryTaskState: () => ({ exists: true, enabled: true }),
    queryTaskXml: () => "<Task />",
    queryNotifierProcesses: () => [],
    waitForNotifierExit: () => true,
    terminateNotifierProcess: (pid) => events.push(["terminate", pid]),
    disableTask: () => events.push(["disable"]),
    enableTask: () => events.push(["enable"]),
    ...overrides
  };
}

function makeInstallAndPackage() {
  const installDir = tempDir("mti-updater-notifier-install-");
  const installExe = path.join(installDir, "MonitorTI-Agent.exe");
  const notifierExe = path.join(installDir, "MonitorTI-Notifier.exe");
  fs.writeFileSync(installExe, "OLD_AGENT");
  fs.writeFileSync(notifierExe, "OLD_NOTIFIER");
  return { installDir, installExe, notifierExe, packageDir: makePackage() };
}

test("Notifier encerrado permite update e task habilitada e restaurada", async () => {
  const files = makeInstallAndPackage();
  const deps = controlledDeps();
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.events, [["disable"], ["enable"]]);
});

test("Notifier que encerra com atraso é aguardado sem kill", async () => {
  const files = makeInstallAndPackage();
  const deps = controlledDeps({
    queryNotifierProcesses: () => [123],
    waitForNotifierExit: (query) => {
      assert.deepEqual(query(), [123]);
      return true;
    }
  });
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.equal(deps.events.some((x) => x[0] === "terminate"), false);
});

test("Notifier persistente recebe kill somente pelo PID exato", async () => {
  const files = makeInstallAndPackage();
  let terminated = false;
  let waits = 0;
  const deps = controlledDeps({
    queryNotifierProcesses: () => (terminated ? [] : [456]),
    waitForNotifierExit: () => waits++ > 0,
    terminateNotifierProcess: (pid) => {
      assert.equal(pid, 456);
      deps.events.push(["terminate", pid]);
      terminated = true;
    }
  });
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.events, [["disable"], ["terminate", 456], ["enable"]]);
});

test("task desabilitada permanece desabilitada", async () => {
  const files = makeInstallAndPackage();
  const deps = controlledDeps({
    queryTaskState: () => ({ exists: true, enabled: false })
  });
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.deepEqual(deps.events, []);
});

test("falha de cópia restaura task habilitada", async () => {
  const files = makeInstallAndPackage();
  const originalCopy = fs.copyFileSync;
  fs.copyFileSync = (source, destination) => {
    if (source === path.join(files.packageDir, "MonitorTI-Notifier.exe")) throw new Error("copy failure");
    return originalCopy(source, destination);
  };
  const deps = controlledDeps();
  try {
    const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
    assert.equal(code, 1);
  } finally {
    fs.copyFileSync = originalCopy;
  }
  assert.deepEqual(deps.events, [["disable"], ["enable"]]);
  assert.equal(fs.readFileSync(files.notifierExe, "utf8"), "OLD_NOTIFIER");
});

test("falha ao encerrar Notifier aborta antes da cópia", async () => {
  const files = makeInstallAndPackage();
  const deps = controlledDeps({
    queryNotifierProcesses: () => [789],
    waitForNotifierExit: () => false,
    terminateNotifierProcess: (pid) => deps.events.push(["terminate", pid]),
  });
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(files.installExe, "utf8"), "OLD_AGENT");
  assert.deepEqual(deps.events, [["disable"], ["terminate", 789], ["enable"]]);
});

test("task ausente mantém compatibilidade e é criada após a cópia", async () => {
  const files = makeInstallAndPackage();
  const events = [];
  const deps = controlledDeps({
    queryTaskState: () => ({ exists: false }),
    queryTaskXml: () => null,
    createOrUpdateTask: () => { events.push(["create"]); return "created"; }
  });
  const code = await runInTest(["node", "x", "--apply-update-package", files.packageDir, files.installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.deepEqual(events, [["create"]]);
});

test("modo legado não consulta nem altera o Notifier", async () => {
  const installDir = tempDir("mti-updater-legacy-install-");
  const installExe = path.join(installDir, "MonitorTI-Agent.exe");
  const deps = {
    queryTaskState: () => { throw new Error("não deve consultar task"); },
    queryNotifierProcesses: () => { throw new Error("não deve consultar processo"); },
    createOrUpdateTask: () => { throw new Error("não deve criar task"); }
  };
  const code = await runInTest(["node", "x", "--apply-update", installExe, "MonitorTIAgent"], deps);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(installExe), true);
});
