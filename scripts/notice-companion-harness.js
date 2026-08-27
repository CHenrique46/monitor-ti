const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { createNoticeRuntime } = require("../agent/src/notices/runtime");
const {
  DIAG_DIR,
  COMMAND_FILE,
  ensureDiagDir,
  isValidCommandName,
  buildCommandPayload,
  readCommandFile,
  claimCommandFile,
  getProcessingFilePath,
  cleanupResidualProcessing,
  commandHistoryPath,
  removeCommandFile,
  markProcessed,
  createCommandGate
} = require("./notice-companion-command");

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function makeTempDir() {
  const dir = path.join(os.tmpdir(), "monitor-ti-phase1-harness");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const configDir = makeTempDir();
const pipePath = "\\\\.\\pipe\\MonitorTI-Notifier";
const commandGate = createCommandGate();
const pendingCommands = new Map();
const readyLogged = new Set();
let healthTimer = null;

function currentSnapshot() {
  try {
    const state = runtime.getState();
    const conn = state.connections && state.connections[0];
    return { state, conn };
  } catch (e) {
    return { state: null, conn: null };
  }
}

function logStatusSnapshot(prefix) {
  const snap = currentSnapshot();
  const conn = snap.conn;
  console.log(prefix + JSON.stringify({
    pid: conn ? conn.pid : null,
    sessionId: conn ? conn.sessionId : null,
    username: conn ? conn.username : null,
    notifierVersion: conn ? conn.notifierVersion : null,
    state: conn ? conn.state : null,
    lastHeartbeat: conn ? conn.lastHeartbeat : null,
    queueLength: snap.state ? snap.state.queueLength : null
  }, null, 2));
}

function logLifecycle(event, extra) {
  const suffix = extra ? " " + extra : "";
  console.log("[runtime] " + event + suffix);
}

function logReadySnapshotOnce() {
  const snap = currentSnapshot();
  const conn = snap.conn;
  if (!conn || conn.state !== "READY" || readyLogged.has(conn.pid)) return;
  readyLogged.add(conn.pid);
  logLifecycle("companion_ready", "pid=" + conn.pid + " session=" + conn.sessionId + " user=" + conn.username + " queue=" + (snap.state ? snap.state.queueLength : "?"));
}

function dispatchNoticeCommand(commandPayload, source) {
  if (!commandPayload || !commandPayload.id) return;
  if (!commandGate.shouldProcess(commandPayload.id)) {
    console.log("[runtime] command_ignored duplicate " + commandPayload.id + " from " + source);
    return;
  }

  pendingCommands.set(commandPayload.id, commandPayload);

  const payload = {
    noticeDeliveryId: commandPayload.id,
    title: "Teste Monitor TI",
    message: "Teste local da nova arquitetura companion.",
    level: "info",
    timestamp: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    scheduledAt: new Date().toISOString(),
    url: "https://exemplo.local/monitor-ti"
  };
  const ok = runtime.enqueueFromServer(payload);
  if (!ok) {
    markProcessed({ id: commandPayload.id, command: commandPayload.command || "notice", processedAt: new Date().toISOString(), result: "rejected" });
    try { removeCommandFile(getProcessingFilePath()); } catch {}
    pendingCommands.delete(commandPayload.id);
  }
  logLifecycle("command_notice", commandPayload.id + " ok=" + ok + " source=" + source);
}

function dispatchStatusCommand(commandPayload, source) {
  if (!commandPayload || !commandPayload.id) return;
  if (!commandGate.shouldProcess(commandPayload.id)) {
    console.log("[runtime] command_ignored duplicate " + commandPayload.id + " from " + source);
    return;
  }
  pendingCommands.set(commandPayload.id, commandPayload);
  logStatusSnapshot("[runtime] status_snapshot ");
  markProcessed({ ...commandPayload, source, processedAt: new Date().toISOString() });
}

function handleCommandPayload(payload, source) {
  if (!payload) return;
  if (payload.partial) return;
  if (payload.invalid) {
    console.log("[runtime] command_invalid from " + source + ": " + payload.reason);
    return;
  }

  const c = String(payload.value.command || "").toLowerCase();
  if (c === "notice") {
    dispatchNoticeCommand(payload.value, source);
    return;
  }
  if (c === "status") {
    dispatchStatusCommand(payload.value, source);
    return;
  }
  console.log("[runtime] command_rejected from " + source + ": " + c);
}

function processCommandFile(source) {
  const processingPath = getProcessingFilePath();
  const residual = cleanupResidualProcessing(processingPath);
  if (residual && residual.action) {
    if (residual.action === "stale_processed") {
      logLifecycle("stale_command_already_processed", residual.id || "unknown");
    } else if (residual.action === "failed") {
      logLifecycle("processing_command_failed", residual.id || "unknown");
    }
  }

  const claimed = claimCommandFile(COMMAND_FILE, processingPath);
  if (!claimed) return;

  const state = readCommandFile(claimed);
  if (!state) return;
  if (state.partial) {
    logLifecycle("command_partial", claimed);
    return;
  }

  const processedPath = commandHistoryPath(state.value.id);
  if (fs.existsSync(processedPath)) {
    logLifecycle("stale_command_already_processed", state.value.id);
    removeCommandFile(claimed);
    return;
  }
  handleCommandPayload(state, source);
  if (state.value && state.value.command === "notice") {
    // notice commands are finalized on acknowledged
    return;
  }
  if (state.value && state.value.command === "status") {
    markProcessed({ id: state.value.id, command: state.value.command, processedAt: new Date().toISOString(), result: "status" });
    removeCommandFile(claimed);
  }
}

function startCommandWatcher() {
  ensureDiagDir();
  processCommandFile("startup");
  return setInterval(() => processCommandFile("poll"), Number(process.env.MTI_PHASE1_COMMAND_POLL_MS || 250));
}

const runtime = createNoticeRuntime({
  configDir,
  getDeviceId: () => "harness-device",
  getAppDir: () => path.join(__dirname, "..", "notifier"),
  logEvent: (m) => console.log("[runtime] " + m),
  version: "1.1.7",
  getInteractiveUser: () => {
    const user = process.env.USERNAME || os.userInfo().username;
    const domain = process.env.USERDOMAIN || null;
    return domain ? domain + "\\" + user : user;
  },
  pipeName: pipePath,
  heartbeatIntervalMs: Number(process.env.MTI_PHASE1_HEARTBEAT_INTERVAL_MS || 15000),
  heartbeatTimeoutMs: Number(process.env.MTI_PHASE1_HEARTBEAT_TIMEOUT_MS || 45000),
  onServerEvent: (evt) => {
    if (!evt || !evt.type) return;
    if (evt.type === "notice_received") {
      logLifecycle("received", evt.noticeDeliveryId + " pid=" + (currentSnapshot().conn ? currentSnapshot().conn.pid : "?"));
      return;
    }
    if (evt.type === "notice_acknowledged") {
      logLifecycle("acknowledged", evt.noticeDeliveryId);
      const record = pendingCommands.get(evt.noticeDeliveryId);
      if (record) {
        markProcessed({ id: evt.noticeDeliveryId, command: record.command || "notice", processedAt: new Date().toISOString(), result: "acknowledged" });
        try { removeCommandFile(getProcessingFilePath()); } catch {}
        pendingCommands.delete(evt.noticeDeliveryId);
      }
      logLifecycle("delivery_final", evt.noticeDeliveryId + " acknowledged");
    }
  }
});

runtime.start();
ensureDiagDir();
logLifecycle("harness_start");
const commandWatcher = startCommandWatcher();

const snapshotTimer = setInterval(() => {
  try {
    const state = runtime.getState();
    const conn = state.connections && state.connections[0];
    if (conn && conn.state === "READY") {
      console.log(JSON.stringify({
        pid: conn.pid,
        sessionId: conn.sessionId,
        username: conn.username,
        notifierVersion: conn.notifierVersion,
        state: conn.state,
        lastHeartbeat: conn.lastHeartbeat
      }, null, 2));
      clearInterval(snapshotTimer);
      logReadySnapshotOnce();
    }
  } catch (e) {}
}, 500);

healthTimer = setInterval(() => {
  try {
    const snap = currentSnapshot();
    const conn = snap.conn;
    console.log("[runtime] harness_still_alive " + JSON.stringify({
      pid: conn ? conn.pid : null,
      state: conn ? conn.state : null,
      queueLength: snap.state ? snap.state.queueLength : null
    }));
  } catch (e) {
    console.log("[runtime] harness_still_alive_error " + e.message);
  }
}, Number(process.env.MTI_PHASE1_HEALTH_MS || 60000));

console.log("Monitor TI companion harness pronto.");
console.log("Pipe: " + pipePath);
console.log("Comandos: notice | status | quit");
console.log("Command file: " + COMMAND_FILE);
console.log("Processing file: " + getProcessingFilePath());
console.log("[runtime] pipe_listening " + pipePath);

process.stdin.resume();

process.on("uncaughtException", (err) => {
  console.log("[runtime] uncaughtException " + (err && err.stack ? err.stack : err && err.message ? err.message : String(err)));
  process.exitCode = 1;
});

process.on("unhandledRejection", (reason) => {
  console.log("[runtime] unhandledRejection " + (reason && reason.stack ? reason.stack : reason && reason.message ? reason.message : String(reason)));
  process.exitCode = 1;
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on("line", (line) => {
  const cmd = String(line || "").trim().toLowerCase();
  if (!cmd) return;
  if (cmd === "quit" || cmd === "exit") {
    logLifecycle("harness_stopping", "explicit");
    runtime.stop();
    rl.close();
    process.exit(0);
    return;
  }
  if (cmd === "status") {
    logStatusSnapshot("");
    return;
  }
  if (cmd === "notice" || cmd === "send") {
    const noticeDeliveryId = uuid();
    dispatchNoticeCommand({ command: "notice", id: noticeDeliveryId, createdAt: new Date().toISOString() }, "stdin");
    console.log(JSON.stringify({ ok: true, noticeDeliveryId }, null, 2));
    return;
  }
  console.log("Comandos: notice | status | quit");
});

process.on("SIGINT", () => {
  try { if (commandWatcher) clearInterval(commandWatcher); } catch {}
  try { if (healthTimer) clearInterval(healthTimer); } catch {}
  runtime.stop();
  process.exit(0);
});

rl.on("close", () => {
  logLifecycle("stdin_closed");
});
