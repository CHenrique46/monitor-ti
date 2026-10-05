const test = require("node:test");
const assert = require("node:assert/strict");
const { createBrowserNotificationHub } = require("./src/services/browserNotificationHub");

test("contrato SSE publica somente payload exato e não mantém histórico", () => {
  const hub = createBrowserNotificationHub({ env: { MTI_BROWSER_CERTIFICATE_NOTIFICATIONS: "1" } });
  const admin = [];
  hub.subscribe("admin", (event) => admin.push(event));
  const eventId = hub.publishAdmin("CERTIFICATE_REQUEST_CREATED");
  assert.match(eventId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(Object.keys(admin[0]).sort(), ["eventId", "eventType"]);
  assert.equal(admin[0].eventId, eventId);
  assert.equal(admin[0].eventType, "CERTIFICATE_REQUEST_CREATED");
  assert.equal(hub.publishAdmin("UNKNOWN"), null);

  const newConnection = [];
  hub.subscribe("admin", (event) => newConnection.push(event));
  assert.deepEqual(newConnection, []);
});

test("isolamento de estação e falha de escrita não interferem em outros assinantes", () => {
  const hub = createBrowserNotificationHub({ env: { MTI_BROWSER_CERTIFICATE_NOTIFICATIONS: "1" } });
  const stationA = [];
  const stationB = [];
  hub.subscribe("computer:7", () => { throw new Error("write failed"); });
  hub.subscribe("computer:7", (event) => stationA.push(event));
  hub.subscribe("computer:8", (event) => stationB.push(event));
  assert.doesNotThrow(() => hub.publishComputer(7, "CERTIFICATE_RELEASED"));
  assert.equal(stationA.length, 1);
  assert.equal(stationB.length, 0);
  assert.equal(Object.keys(stationA[0]).some((key) => /hostname|ip|certificado|motivo|texto|body|title/i.test(key)), false);
});
