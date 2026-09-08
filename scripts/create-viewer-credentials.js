const { createPasswordHash } = require("../server/src/auth/service");

const username = String(process.argv[2] || "consulta").trim();
const password = process.env.HT_VIEWER_PASSWORD;

if (!username || !password) {
  console.error("Uso: HT_VIEWER_PASSWORD=<senha> node scripts/create-viewer-credentials.js [username]");
  process.exitCode = 1;
} else {
  console.log(`HT_VIEWER_USERNAME=${username}`);
  console.log(`HT_VIEWER_PASSWORD_HASH=${createPasswordHash(password)}`);
}
