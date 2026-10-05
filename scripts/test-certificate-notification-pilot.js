const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");

const { createNoticeBridge } = require("../agent/src/notices/bridge");
const {
  CERTIFICATE_NOTIFICATION_TEST,
  CERTIFICATE_NOTIFICATION_TEST_TYPE,
  FIXED_TITLE,
  FIXED_MESSAGE,
  validateCertificateNotificationTest,
  buildCertificateNotificationAck,
  validateCertificateNotificationAck
} = require("../agent/src/certificateNotificationTest");
const agentServer = require("../server/src/ws/agentServer");
const logger = require("../server/src/logger");
const { handleCertificateNotificationMessage } = require("../agent/src/certificateNotificationHandler");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function uuid() { return crypto.randomUUID(); }
function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "mti-cert-pilot-")); }

function client(pipePath) {
  const socket = net.createConnection(pipePath);
  socket.setEncoding("utf8");
  let buffer = "";
  const lines = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) lines.push(JSON.parse(line));
    }
    while (lines.length && waiters.length) waiters.shift()(lines.shift());
  });
  return {
    socket,
    connect: () => new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); }),
    send: (value) => socket.write(JSON.stringify(value) + "\n"),
    next: (timeout = 3000) => new Promise((resolve, reject) => {
      if (lines.length) return resolve(lines.shift());
      const timer = setTimeout(() => reject(new Error("pipe timeout")), timeout);
      waiters.push((line) => { clearTimeout(timer); resolve(line); });
    }),
    close: () => socket.destroy()
  };
}

async function main() {
  const sent = [];
  const ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  const eventId = uuid();
  const bridge = createNoticeBridge({
    configDir: tempDir(),
    getAppDir: () => tempDir(),
    getDeviceId: () => "00000000-0000-4000-8000-000000000001",
    version: "1.1.25",
    companionEnabled: true,
    certificateNotificationTestEnabled: true,
    pipeName: "MonitorTI-CertificatePilot-" + uuid(),
    getInteractiveUser: () => "Test User",
    processInfoLookup: () => ({ exists: true, sessionId: 1, domain: "TEST", user: "Test User" }),
    logEvent: () => {}
  });
  bridge.onWsOpen(ws);
  const pipe = client(bridge.getRuntimeState().pipePath);
  await pipe.connect();
  pipe.send({ type: "register", protocolVersion: 1, notifierVersion: "1.1.25", sessionId: 1, pid: 7448, username: "TEST\\Test User", activeNoticeDeliveryId: null });
  assert.equal((await pipe.next()).type, "register_ok");
  pipe.send({ type: "heartbeat", protocolVersion: 1, sessionId: 1, pid: 7448, ts: new Date().toISOString() });
  await wait(50);

  assert.equal(validateCertificateNotificationTest({ type: CERTIFICATE_NOTIFICATION_TEST_TYPE, protocolVersion: 1, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST }).ok, true);
  assert.equal(validateCertificateNotificationTest({ type: CERTIFICATE_NOTIFICATION_TEST_TYPE, protocolVersion: 1, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST, title: "arbitrário" }).ok, false);
  const pilotAcks = [];
  const handlerWs = { send: (raw) => pilotAcks.push(JSON.parse(raw)) };
  assert.equal(handleCertificateNotificationMessage({
    ws: handlerWs,
    msg: { type: CERTIFICATE_NOTIFICATION_TEST_TYPE, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST },
    noticesBridge: bridge,
    logEvent: () => {}
  }).accepted, true);
  assert.deepEqual(pilotAcks.map((ack) => ack.status), ["RECEIVED"]);
  const routed = await pipe.next();
  assert.deepEqual(routed, { type: CERTIFICATE_NOTIFICATION_TEST_TYPE, protocolVersion: 1, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST });
  assert.equal(handleCertificateNotificationMessage({
    ws: handlerWs,
    msg: { type: CERTIFICATE_NOTIFICATION_TEST_TYPE, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST },
    noticesBridge: bridge,
    logEvent: () => {}
  }).accepted, false);
  pipe.send({ type: "certificate_notification_test_status", protocolVersion: 1, eventId, eventType: CERTIFICATE_NOTIFICATION_TEST, status: "DISPLAYED" });
  await wait(100);
  assert.equal(sent.some((m) => m.type === "certificate_notification_test_ack" && m.status === "DISPLAYED"), true);
  assert.equal(sent.some((m) => m.type === "notice_received" || m.type === "notice_acknowledged"), false);
  bridge.shutdown();
  pipe.close();

  agentServer.reloadPilotConfigForTests({});
  agentServer.setCapabilities(agentServer.PILOT_DEVICE_ID, ["notices", agentServer.PILOT_CAPABILITY]);
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, () => true), false);

  const pilotEnv = {
    MTI_CERTIFICATE_NOTIFICATION_TEST: "1",
    MTI_CERTIFICATE_NOTIFICATION_TARGET_DEVICE_ID: agentServer.PILOT_DEVICE_ID,
    MTI_CERTIFICATE_NOTIFICATION_EVENT_ID: uuid()
  };
  agentServer.reloadPilotConfigForTests(pilotEnv);
  agentServer.setCapabilities(agentServer.PILOT_DEVICE_ID, ["notices", agentServer.PILOT_CAPABILITY]);
  const targeted = [];
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, (deviceId, payload, done) => {
    targeted.push({ deviceId, payload });
    done();
    return true;
  }), true);
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].deviceId, agentServer.PILOT_DEVICE_ID);
  assert.deepEqual(Object.keys(targeted[0].payload).sort(), ["eventId", "eventType", "type"]);
  assert.equal(agentServer.sendCertificateNotificationTest("outro-device", () => true), false);
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, () => true), false);
  agentServer.reloadPilotConfigForTests(pilotEnv);
  agentServer.setCapabilities(agentServer.PILOT_DEVICE_ID, ["notices"]);
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, () => true), false);
  agentServer.reloadPilotConfigForTests({});
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, () => true), false);

  const ack = buildCertificateNotificationAck(eventId, "DISPLAYED", "raw stack is not accepted");
  assert.deepEqual(ack, { type: "certificate_notification_test_ack", eventId, status: "DISPLAYED" });
  assert.equal(validateCertificateNotificationAck(ack).ok, true);
  assert.equal(validateCertificateNotificationAck({ ...ack, user: "TEST" }).ok, false);
  assert.equal(validateCertificateNotificationAck(buildCertificateNotificationAck(eventId, "FAILED", "TOAST_DISPLAY_FAILED")).ok, true);
  const originalLogEvent = logger.logEvent;
  const logs = [];
  logger.logEvent = (line) => logs.push(line);
  agentServer.reloadPilotConfigForTests(pilotEnv);
  agentServer.setCapabilities(agentServer.PILOT_DEVICE_ID, ["notices", agentServer.PILOT_CAPABILITY]);
  assert.equal(agentServer.sendCertificateNotificationTest(agentServer.PILOT_DEVICE_ID, (deviceId, payload, done) => {
    done();
    return true;
  }), true);
  logs.length = 0;
  const ackWs = { deviceId: agentServer.PILOT_DEVICE_ID };
  assert.equal(agentServer.handleCertificateNotificationTestAck(ackWs, {
    type: "certificate_notification_test_ack",
    eventId: pilotEnv.MTI_CERTIFICATE_NOTIFICATION_EVENT_ID,
    status: "DISPLAYED"
  }), true);
  assert.equal(agentServer.handleCertificateNotificationTestAck(ackWs, {
    type: "certificate_notification_test_ack",
    eventId: pilotEnv.MTI_CERTIFICATE_NOTIFICATION_EVENT_ID,
    status: "DISPLAYED",
    user: "TEST"
  }), false);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /TEST|HenriTech|stack|path/i);
  logger.logEvent = originalLogEvent;

  assert.equal(FIXED_TITLE, "HenriTech Control");
  assert.equal(FIXED_MESSAGE, "Teste concluído. As notificações de certificados estão funcionando nesta máquina.");
  console.log("PASS certificate notification pilot contract");
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
