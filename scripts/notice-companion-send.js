const { uuid, buildCommandPayload, writeCommandFileAtomic, isValidCommandName } = require("./notice-companion-command");

const command = String(process.argv[2] || "notice").trim().toLowerCase();

if (!isValidCommandName(command)) {
  console.error("command inválido. use: notice | status");
  process.exit(1);
}

const id = uuid();
const payload = buildCommandPayload(command, id, new Date().toISOString());

try {
  writeCommandFileAtomic(payload);
  console.log(id);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
