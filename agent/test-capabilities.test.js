const test = require("node:test");
const assert = require("node:assert/strict");

const { composeCapabilities } = require("./src/capabilities");
const { createNoticeBridge } = require("./src/notices/bridge");

function notifier(ready) {
  return { isNotifierReady: () => ready() };
}

test("capabilities nativas e dinamicas sao compostas sem duplicatas", () => {
  let ready = false;
  assert.deepEqual(composeCapabilities({ version: "1.1.19", notifier: notifier(() => ready) }), []);
  assert.deepEqual(composeCapabilities({ version: "1.1.20", notifier: notifier(() => ready) }), ["disk_cleanup_analyze"]);
  ready = true;
  assert.deepEqual(composeCapabilities({ version: "1.1.20", notifier: notifier(() => ready) }), ["disk_cleanup_analyze", "notices"]);
});

test("mudanca de readiness e reconexao reanunciam o conjunto completo", () => {
  let ready = false;
  const sent = [];
  let onCapabilityChange;
  const bridge = createNoticeBridge({
    configDir: "test",
    getAppDir: () => "test",
    getDeviceId: () => "dev-1",
    version: "1.1.20",
    companionEnabled: true,
    logEvent: () => {}
  }, {
    createNoticeRuntime: (options) => {
      onCapabilityChange = options.onCapabilityChange;
      return { start() {}, isNotifierReady: () => ready, stop() {} };
    }
  });
  const ws = { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) };

  bridge.onWsOpen(ws);
  assert.deepEqual(sent.at(-1).data.capabilities, ["disk_cleanup_analyze"]);
  ready = true;
  onCapabilityChange(["notices"], "ready");
  assert.deepEqual(sent.at(-1).data.capabilities, ["disk_cleanup_analyze", "notices"]);
  ready = false;
  onCapabilityChange([], "disconnect");
  assert.deepEqual(sent.at(-1).data.capabilities, ["disk_cleanup_analyze"]);
  bridge.onWsClose(ws);
  bridge.onWsOpen(ws);
  assert.deepEqual(sent.at(-1).data.capabilities, ["disk_cleanup_analyze"]);
});

test("resultado estruturado distingue BUSY sem alterar o retorno booleano normal", () => {
  const bridge = createNoticeBridge({
    configDir: "test",
    getAppDir: () => "test",
    getDeviceId: () => "dev-busy",
    version: "1.1.20",
    companionEnabled: true,
    logEvent: () => {}
  }, {
    createNoticeRuntime: () => ({
      start() {},
      stop() {},
      isNotifierReady: () => true,
      enqueueFromServerResult: () => ({ accepted: false, reason: "BUSY", message: "Aviso já em exibição" })
    })
  });
  const ws = { readyState: 1, send() {} };
  const payload = { type: "notice_show", protocolVersion: 1, noticeDeliveryId: "123e4567-e89b-12d3-a456-426614174000", title: "T", message: "M", level: "info", timestamp: new Date().toISOString() };

  assert.deepEqual(bridge.handleServerMessageResult(ws, payload), { accepted: false, reason: "BUSY", message: "Aviso já em exibição" });
  assert.equal(bridge.handleServerMessage(ws, payload), false);
});
