const fs = require("fs");
const path = require("path");
const os = require("os");
const { createNoticeBridge } = require("../agent/src/notices/bridge");
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

function makeBridge(execResult = {}) {
  const calls = [];
  const runtime = {
    started: true,
    ready: false,
    requestShutdown: async (reason, timeoutMs) => {
      calls.push({ kind: "shutdown", reason, timeoutMs });
      return execResult.shutdown !== undefined ? execResult.shutdown : true;
    },
    stop() {
      calls.push({ kind: "stop" });
      runtime.started = false;
    },
    isNotifierReady() {
      return runtime.ready;
    },
    start() {
      calls.push({ kind: "start" });
    },
    enqueueFromServer() {
      return true;
    },
    getState() {
      return { pipePath: "\\\\.\\pipe\\MonitorTI-Notifier", connections: [], queueLength: 0 };
    }
  };

  const execCalls = [];
  const bridge = createNoticeBridge(
    {
      configDir: tempDir("mti-update-"),
      getAppDir: () => path.join(__dirname, "..", "release", "agent-test"),
      getDeviceId: () => "device-update",
      getServerHttpBase: () => "http://127.0.0.1:0",
      logEvent: () => {},
      version: AGENT_VERSION,
      getInteractiveUser: () => (execResult.interactiveUser === undefined ? "Henrique" : execResult.interactiveUser),
      companionEnabled: true
    },
    {
      createNoticeRuntime() {
        return runtime;
      },
      execFileSync(cmd, args, opts) {
        execCalls.push({ cmd, args, opts });
        if (cmd.toLowerCase().includes("powershell")) {
          const modeIndex = args.findIndex((a) => String(a).toLowerCase() === "-mode");
          const mode = modeIndex >= 0 ? String(args[modeIndex + 1] || "") : "";
          if (mode === "state") {
            if (execResult.queryThrows) throw new Error("task ausente");
            return JSON.stringify({ exists: true, groupId: "S-1-5-11" });
          }
          if (mode === "run") {
            if (execResult.runThrows) throw new Error("run bloqueado");
            return "";
          }
          return "";
        }
        return "";
      }
    }
  );

  return { bridge, runtime, calls, execCalls };
}

function makeWs() {
  const sent = [];
  return {
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    }
  };
}

async function main() {
  // UPDATE-001 shutdown -> ack.
  {
    const { bridge, calls } = makeBridge({ shutdown: true });
    const ok = await bridge.shutdownForUpdate();
    check("UPDATE-001 shutdown -> ack", ok === true && calls.some((c) => c.kind === "shutdown" && c.reason === "update" && c.timeoutMs === 10000));
  }

  // UPDATE-002 shutdown timeout.
  {
    const { bridge } = makeBridge({ shutdown: false });
    const ok = await bridge.shutdownForUpdate();
    check("UPDATE-002 shutdown timeout", ok === false);
  }

  // UPDATE-003 companion fecha antes do swap.
  {
    const { bridge, calls } = makeBridge({ shutdown: true });
    await bridge.shutdownForUpdate();
    bridge.shutdown();
    check("UPDATE-003 companion fecha antes swap", calls.some((c) => c.kind === "stop"));
  }

  // UPDATE-004 Agent+Notifier package swap.
  {
    const updater = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "updater.js"), "utf8");
    check("UPDATE-004 package swap", /--apply-update-package/.test(updater) && /MonitorTI-Notifier\.exe/.test(updater));
  }

  // UPDATE-005 rollback.
  {
    const updater = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "updater.js"), "utf8");
    check("UPDATE-005 rollback", /function rollback\(\)/.test(updater) && /INICIANDO ROLLBACK/.test(updater));
  }

  // UPDATE-006 task relaunch quando sessão ativa.
  {
    const { bridge, runtime, execCalls } = makeBridge({ shutdown: true });
    runtime.ready = true;
    const ws = makeWs();
    bridge.onWsOpen(ws);
    bridge.attemptCompanionTaskRunIfNeeded();
    check("UPDATE-006 task relaunch quando sessão ativa", execCalls.some((c) => c.cmd.toLowerCase().includes("powershell") && c.args.includes("-Mode") && c.args.includes("run")));
  }

  // UPDATE-007 sem sessão => não relaunch.
  {
    const { bridge, execCalls } = makeBridge({ interactiveUser: null });
    bridge.attemptCompanionTaskRunIfNeeded();
    check("UPDATE-007 sem sessão => não relaunch", !execCalls.some((c) => c.args[0] === "/run"));
  }

  // UPDATE-008 reconnect/capability depois update.
  {
    const { bridge, runtime } = makeBridge({ shutdown: true });
    const ws = makeWs();
    runtime.ready = false;
    bridge.onWsOpen(ws);
    runtime.ready = true;
    bridge.onWsClose(ws);
    bridge.onWsOpen(ws);
    const caps = ws.sent.filter((m) => m.type === "capabilities").map((m) => (m.data && m.data.capabilities) || []);
    check("UPDATE-008 reconnect/capability depois update", caps.some((c) => Array.isArray(c) && c.length === 0) && caps.some((c) => Array.isArray(c) && c.includes("notices")));
  }

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
