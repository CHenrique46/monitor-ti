// LEGACY-DIAG: Session 0 -> Session 1 promotion smoke.
// Não é gate obrigatório da 1.1.8.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const exe = path.join(__dirname, "..", "release", "agent-test", "MonitorTI-Notifier.exe");
const tmpDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "mti-promo-"));
const payload = path.join(tmpDir, "payload.json");
fs.writeFileSync(
  payload,
  JSON.stringify({
    noticeDeliveryId: "11111111-1111-1111-1111-111111111111",
    title: "Teste Monitor TI",
    message: "Teste de promocao isolado.",
    level: "info",
    timestamp: new Date().toISOString()
  })
);

const pipeName = "MonitorTI-Notice-11111111-1111-1111-1111-111111111111";
const result = spawnSync(exe, ["--pipe", pipeName, "--payload", payload], {
  windowsHide: true,
  encoding: "utf8",
  timeout: 15000
});

console.log(JSON.stringify({
  status: result.status,
  error: result.error ? result.error.message : null,
  stdout: result.stdout || null,
  stderr: result.stderr || null
}, null, 2));
