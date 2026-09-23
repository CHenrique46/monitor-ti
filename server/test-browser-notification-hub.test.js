const assert = require("assert");
const { createBrowserNotificationHub } = require("./src/services/browserNotificationHub");

async function run() {
  const disabledHub = createBrowserNotificationHub({ env: {} });
  assert.strictEqual(disabledHub.isEnabled(), false);
  assert.strictEqual(disabledHub.publishAdmin("CERTIFICATE_REQUEST_CREATED"), null);
  const env = { MTI_BROWSER_CERTIFICATE_NOTIFICATIONS: "1" };
  const hub = createBrowserNotificationHub({ env, maxConnections: 2 });
  const admin = [];
  const computerOne = [];
  const computerTwo = [];
  const closeAdmin = hub.subscribe("admin", (event) => admin.push(event));
  const closeOne = hub.subscribe("computer:7", (event) => computerOne.push(event));
  assert.throws(() => hub.subscribe("computer:8", () => {}), /CONNECTION_LIMIT/);

  hub.publishAdmin("CERTIFICATE_REQUEST_CREATED");
  hub.publishComputer(7, "CERTIFICATE_RELEASED");
  hub.publishComputer(8, "CERTIFICATE_RELEASED");
  hub.publishAdmin("not-allowlisted");

  assert.strictEqual(admin.length, 1);
  assert.strictEqual(admin[0].eventType, "CERTIFICATE_REQUEST_CREATED");
  assert.strictEqual(computerOne.length, 1);
  assert.strictEqual(computerOne[0].eventType, "CERTIFICATE_RELEASED");
  assert.strictEqual(computerTwo.length, 0);
  assert.deepStrictEqual(Object.keys(admin[0]).sort(), ["eventId", "eventType"]);
  closeAdmin();
  closeOne();

  let authorized = true;
  const protectedEvents = [];
  hub.subscribe("computer:9", (event) => protectedEvents.push(event), () => authorized);
  authorized = false;
  hub.publishComputer(9, "CERTIFICATE_RELEASED");
  assert.strictEqual(protectedEvents.length, 0);
  assert.strictEqual(hub.connectionCount(), 0);

  env.MTI_BROWSER_CERTIFICATE_NOTIFICATIONS = "0";
  assert.strictEqual(hub.isEnabled(), false);
  assert.strictEqual(hub.publishAdmin("CERTIFICATE_REQUEST_CREATED"), null);
  console.log("browser notification hub tests passed");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
