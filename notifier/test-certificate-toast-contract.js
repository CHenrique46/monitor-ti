const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "MonitorTI-Notifier.cs"), "utf8");

assert.match(source, /AppUserModelId = "HenriTech\.Control\.Notifier"/);
assert.match(source, /Teste concluído\. As notificações de certificados estão funcionando nesta máquina\./);
assert.match(source, /Nova solicitação de certificado/);
assert.match(source, /Certificado liberado/);
assert.match(source, /certificate_notification_test_status/);
assert.match(source, /"DISPLAYED"/);
assert.match(source, /"DUPLICATE"/);
assert.match(source, /"TOAST_DISPLAY_FAILED"/);
assert.match(source, /MAX_CERTIFICATE_EVENTS = 100/);
assert.match(source, /ParseCertificatePayload/);
assert.match(source, /HasOnlyJsonKeys/);
console.log("notifier certificate toast contract: ok");
