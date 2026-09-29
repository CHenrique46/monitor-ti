const assert = require("node:assert/strict");
const agentServer = require("../server/src/ws/agentServer");

const deviceId = agentServer.PILOT_DEVICE_ID;
const eventId = "e0b7c7b6-41f4-4c46-8f30-2e2ed8bbf8a1";
const env = {
  MTI_CERTIFICATE_NOTIFICATION_TEST: "1",
  MTI_CERTIFICATE_NOTIFICATION_TARGET_DEVICE_ID: deviceId,
  MTI_CERTIFICATE_NOTIFICATION_EVENT_ID: eventId
};

for (const status of ["RECEIVED", "DISPLAYED", "DUPLICATE", "FAILED"]) {
  agentServer.reloadPilotConfigForTests(env);
  agentServer.setCapabilities(deviceId, ["notices", agentServer.PILOT_CAPABILITY]);
  const socket = {
    connectionId: `focused-${status}`,
    deviceId,
    registered: true,
    readyState: 1,
    OPEN: 1,
    send: (_payload, callback) => callback()
  };
  assert.equal(agentServer.sendCertificateNotificationTest(deviceId, undefined, socket), true);
  assert.equal(agentServer.handleCertificateNotificationTestAck(socket, {
    type: "certificate_notification_test_ack",
    eventId,
    status
  }), true);
}

agentServer.reloadPilotConfigForTests(env);
agentServer.setCapabilities(deviceId, ["notices"]);
const noCapabilitySocket = { connectionId: "focused-no-capability", deviceId, registered: true, readyState: 1, OPEN: 1, send: () => { throw new Error("must not send"); } };
assert.equal(agentServer.sendCertificateNotificationTest(deviceId, undefined, noCapabilitySocket), false);
agentServer.reloadPilotConfigForTests({});
console.log("focused certificate notification protocol: ok");
