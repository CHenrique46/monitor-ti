const fs = require("fs");
const os = require("os");
const path = require("path");
const { createNoticeBridge } = require("../agent/src/notices/bridge");

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeBridge(options = {}) {
  const logs = [];
  let runCount = 0;
  let capabilityChange = null;
  const runtime = {
    ready: false,
    isNotifierReady: () => runtime.ready,
    start: () => {},
    stop: () => {},
    enqueueFromServer: () => true,
    getReadinessStatus: () => ({ status: runtime.ready ? "READY" : "DISCONNECTED" })
  };
  const bridge = createNoticeBridge({
    configDir: fs.mkdtempSync(path.join(os.tmpdir(), "mti-recovery-")),
    getAppDir: () => __dirname,
    getDeviceId: () => "test-device",
    version: "1.1.19-dev",
    companionEnabled: true,
    getInteractiveUser: () => options.user === undefined ? "tester" : options.user,
    logEvent: (line) => logs.push(line),
    recoveryGracePeriodMs: options.grace === undefined ? 1 : options.grace,
    recoveryCooldownMs: options.cooldown === undefined ? 5 : options.cooldown,
    recoveryBackoffInitialMs: 2,
    recoveryBackoffMaxMs: 4,
    recoveryWindowMs: 30,
    recoveryMaxAttempts: 3
  }, {
    createNoticeRuntime(opts) {
      capabilityChange = opts.onCapabilityChange;
      return runtime;
    },
    queryTaskState: () => ({ exists: true }),
    runTask: () => {
      runCount += 1;
      if (options.failRun) throw new Error("task failure");
    }
  });
  return { bridge, runtime, logs, get runCount() { return runCount; }, setCapability: (caps, reason) => capabilityChange(caps, reason) };
}

async function main() {
  {
    const c = makeBridge();
    c.runtime.ready = true;
    c.setCapability(["notices"]);
    check("A READY saudável não reinicia", c.runCount === 0);
  }
  {
    const c = makeBridge();
    c.setCapability([]);
    await wait(4);
    check("B DISCONNECTED agenda recovery", c.runCount === 1 && c.logs.some((x) => x.includes("companion_recovery_attempt reason=disconnect")));
  }
  {
    const c = makeBridge();
    c.setCapability([], "heartbeat_timeout");
    await wait(4);
    check("C heartbeat timeout agenda recovery", c.runCount === 1 && c.logs.some((x) => x.includes("reason=heartbeat_timeout")));
  }
  {
    const c = makeBridge({ user: null });
    c.setCapability([]);
    await wait(4);
    check("D sem sessão não inicia", c.runCount === 0 && c.logs.some((x) => x.includes("no_interactive_session")));
  }
  {
    const c = makeBridge({ cooldown: 20 });
    c.setCapability([]);
    await wait(4);
    c.setCapability([]);
    check("E cooldown não repete", c.runCount === 1);
  }
  {
    const c = makeBridge({ failRun: true, cooldown: 1 });
    c.setCapability([]);
    await wait(30);
    check("F falha aplica backoff", c.runCount >= 2 && c.logs.some((x) => x.includes("companion_recovery_failed")));
  }
  {
    const c = makeBridge({ cooldown: 30 });
    c.setCapability([]);
    await wait(4);
    c.runtime.ready = true;
    c.setCapability(["notices"]);
    check("G READY limpa recovery", c.bridge.getRecoveryState().attempts === 0 && c.bridge.getRecoveryState().cooldownUntil === 0);
  }
  {
    const c = makeBridge({ cooldown: 20 });
    c.setCapability([]);
    c.setCapability([]);
    await wait(4);
    check("H disconnects próximos geram uma recuperação", c.runCount === 1);
  }
  {
    const integrity = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "notifier.js"), "utf8");
    check("I recovery preserva validação de metadata e SHA", /notifier-integrity\.json/.test(integrity) && /sha256/i.test(integrity));
  }
  {
    const bridgeSource = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "notices", "bridge.js"), "utf8");
    check("J AgentRelease remoto é irrelevante", !/AgentRelease/.test(bridgeSource) && /runTask\(\)/.test(bridgeSource));
  }
  console.log(`RECOVERY TESTS: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
