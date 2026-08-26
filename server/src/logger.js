const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(
  process.env.ProgramData || "C:\\ProgramData",
  "MonitorTI",
  "server",
  "logs"
);

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  } catch (e) {
    // Se nao conseguir criar o diretorio, apenas loga no console.
  }
}

function logEvent(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    ensureDir();
    fs.appendFileSync(path.join(LOG_DIR, "server.log"), line + "\n");
  } catch (e) {
    // Falha de escrita nao deve derrubar o servidor.
  }
}

module.exports = { logEvent, LOG_DIR };
