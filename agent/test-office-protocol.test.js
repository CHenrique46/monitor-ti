const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createOfficeInventorySender, scheduleOfficeInventory } = require("./src/inventory/officeProtocol");

function socket() {
  return { OPEN: 1, readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
}

const inventory = {
  collectedAt: "2026-09-02T12:00:00.000Z",
  installations: [{ source: "CLICK_TO_RUN", productReleaseId: "O365ProPlusRetail", version: "16.0.1", partialProductKey: "ABCDE", fingerprint: "f1" }],
  warnings: []
};

test("collector success sends a separate inventory event", async () => {
  const ws = socket();
  const sender = createOfficeInventorySender({ collector: async () => inventory });
  const result = await sender.send(ws, "device-1");
  assert.deepEqual(result, { sent: true, installations: 1 });
  assert.equal(ws.sent[0].type, "inventory");
  assert.equal(ws.sent[0].deviceId, "device-1");
  assert.equal(ws.sent[0].data.office.installations.length, 1);
});

test("empty Office inventory is sent and collector failure is isolated", async () => {
  const ws = socket();
  const empty = createOfficeInventorySender({ collector: async () => ({ collectedAt: "now", installations: [], warnings: [] }) });
  assert.equal((await empty.send(ws, "device-1")).sent, true);
  assert.deepEqual(ws.sent[0].data.office.installations, []);

  const failed = createOfficeInventorySender({ collector: async () => { throw new Error("synthetic failure"); } });
  assert.deepEqual(await failed.send(ws, "device-1"), { sent: false, reason: "collector_failed" });
});

test("same inventory is not sent twice and full keys/raw fields are excluded", async () => {
  const ws = socket();
  const sender = createOfficeInventorySender({ collector: async () => ({
    ...inventory,
    installations: [{ ...inventory.installations[0], licenseName: "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE", rawOutput: "raw ospp" }]
  }) });
  assert.equal((await sender.send(ws, "device-1")).sent, true);
  assert.deepEqual(await sender.send(ws, "device-1"), { sent: false, reason: "unchanged" });
  const payload = JSON.stringify(ws.sent[0]);
  assert.doesNotMatch(payload, /AAAAA-BBBBB-CCCCC-DDDDD-EEEEE|raw ospp/);
});

test("inventory scheduling is asynchronous and does not block the caller", async () => {
  let ran = false;
  scheduleOfficeInventory(() => { ran = true; }, 10);
  assert.equal(ran, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ran, true);
});

test("register and metrics protocol paths remain unchanged", () => {
  const source = fs.readFileSync(path.join(__dirname, "src/index.js"), "utf8");
  assert.match(source, /ws\.send\(JSON\.stringify\(\{ type: "register", data: machine \}\)\)/);
  assert.match(source, /ws\.send\(JSON\.stringify\(\{ type: "metrics", data: metrics \}\)\)/);
  assert.doesNotMatch(source, /office:/);
});
