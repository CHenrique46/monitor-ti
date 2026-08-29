const assert = require("assert");
const { validateNoticeShow } = require("../agent/src/notices/protocol");

async function run() {
  const agentServer = require("../server/src/ws/agentServer");
  const avisosService = require("../server/src/services/avisos.service");

  const originalHasCapability = agentServer.hasCapability;
  const originalSendToAgent = agentServer.sendToAgent;

  let captured = null;
  try {
    agentServer.hasCapability = () => true;
    agentServer.sendToAgent = (_deviceId, obj) => {
      captured = obj;
      return true;
    };

    const entrega = {
      noticeDeliveryId: "cdf120c7-be2d-4e1c-94d4-5cf8ba1091a4",
      titulo: "Teste Monitor TI - 1.1.15",
      mensagem: "Este é um teste do sistema de avisos do Monitor TI.",
      nivel: "info",
      criadoEm: new Date("2026-08-29T00:19:56.660Z"),
      expiraEm: new Date("2026-08-29T01:19:56.660Z"),
      ocorrencia: { agendadoPara: new Date("2026-08-29T00:19:56.660Z") }
    };

    const ok = await avisosService.enviarParaAgente("840393f4-e725-4169-a23a-f851e0ef918b", entrega);

    assert.strictEqual(ok, true);
    assert.ok(captured, "payload nao foi capturado");
  } finally {
    agentServer.hasCapability = originalHasCapability;
    agentServer.sendToAgent = originalSendToAgent;
  }

  assert.strictEqual(captured.type, "notice_show");
  assert.strictEqual(captured.noticeDeliveryId, "cdf120c7-be2d-4e1c-94d4-5cf8ba1091a4");
  assert.strictEqual(captured.protocolVersion, 1);
  assert.strictEqual(captured.title, "Teste Monitor TI - 1.1.15");
  assert.strictEqual(captured.message, "Este é um teste do sistema de avisos do Monitor TI.");
  assert.strictEqual(captured.level, "info");
  assert.strictEqual(captured.timestamp, "2026-08-29T00:19:56.660Z");
  assert.strictEqual(captured.scheduledAt, "2026-08-29T00:19:56.660Z");
  assert.strictEqual(captured.expiresAt, "2026-08-29T01:19:56.660Z");
  assert.strictEqual(captured.serverTime, "2026-08-29T00:19:56.660Z");
  assert.strictEqual(validateNoticeShow(captured).ok, true);
  assert.deepStrictEqual(Object.keys(captured).sort(), [
    "expiresAt",
    "level",
    "message",
    "noticeDeliveryId",
    "protocolVersion",
    "scheduledAt",
    "serverTime",
    "timestamp",
    "title",
    "type"
  ].sort());
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "titulo"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "mensagem"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "nivel"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "title"), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "message"), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(captured, "level"), true);

  console.log("PASS backend notice_show contract");
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
