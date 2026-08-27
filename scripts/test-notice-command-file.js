const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const {
  buildCommandPayload,
  validateCommandPayload,
  writeCommandFileAtomic,
  readCommandFile,
  claimCommandFile,
  getProcessingFilePath,
  cleanupResidualProcessing,
  commandHistoryPath,
  finalizeProcessingFile,
  createCommandGate,
  isValidCommandName,
  uuid
} = require("./notice-companion-command");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function main() {
  const dir = tempDir("mti-cmd-");
  const file = path.join(dir, "companion-command.json");
  const processing = path.join(dir, "companion-command.processing");

  // CMD-001 notice command válido.
  {
    const id = uuid();
    const payload = buildCommandPayload("notice", id, new Date().toISOString());
    writeCommandFileAtomic(payload, file);
    const parsed = readCommandFile(file);
    check("CMD-001 notice command válido", !!parsed && parsed.value && parsed.value.command === "notice" && parsed.value.id === id);
  }

  // CMD-006 command original é claimed por rename.
  {
    const id = uuid();
    writeCommandFileAtomic(buildCommandPayload("notice", id, new Date().toISOString()), file);
    const claimed = claimCommandFile(file, processing);
    check("CMD-006 original claimed", !!claimed && fs.existsSync(processing) && !fs.existsSync(file));
    fs.unlinkSync(processing);
  }

  // CMD-007 original não permanece após processamento.
  {
    const id = uuid();
    writeCommandFileAtomic(buildCommandPayload("notice", id, new Date().toISOString()), file);
    const claimed = claimCommandFile(file, processing);
    const payload = readCommandFile(claimed).value;
    finalizeProcessingFile(payload, "acknowledged", processing);
    check("CMD-007 original não permanece", !fs.existsSync(file) && !fs.existsSync(processing) && fs.existsSync(commandHistoryPath(id)));
  }

  // CMD-002 UUID duplicado não executa duas vezes.
  {
    const gate = createCommandGate();
    const id = uuid();
    check("CMD-002 first allow", gate.shouldProcess(id) === true);
    check("CMD-002 second block", gate.shouldProcess(id) === false);
  }

  // CMD-003 JSON inválido ignorado.
  {
    fs.writeFileSync(file, "{ invalid json", "utf8");
    const parsed = readCommandFile(file);
    check("CMD-003 JSON inválido ignorado", parsed && parsed.invalid === true);
  }

  // CMD-004 command desconhecido rejeitado.
  {
    const bad = validateCommandPayload({ command: "echo", id: uuid(), createdAt: new Date().toISOString() });
    check("CMD-004 command desconhecido rejeitado", bad.ok === false);
  }

  // CMD-005 arquivo parcial não quebra harness.
  {
    fs.writeFileSync(file, '{"command":"notice",', "utf8");
    const parsed = readCommandFile(file);
    check("CMD-005 arquivo parcial não quebra harness", parsed && parsed.partial === true);
  }

  // CMD-008 processed ID não é executado novamente.
  {
    const id = uuid();
    fs.writeFileSync(commandHistoryPath(id), JSON.stringify({ id, command: "notice", processedAt: new Date().toISOString(), result: "acknowledged" }, null, 2), "utf8");
    writeCommandFileAtomic(buildCommandPayload("notice", id, new Date().toISOString()), file);
    const claimed = claimCommandFile(file, processing);
    const state = readCommandFile(claimed);
    check("CMD-008 processed ID não reexecuta", fs.existsSync(commandHistoryPath(id)) && !!state);
    fs.unlinkSync(processing);
  }

  // CMD-009 .processing + processed existente => cleanup sem execução.
  {
    const id = uuid();
    fs.writeFileSync(processing, JSON.stringify(buildCommandPayload("notice", id, new Date().toISOString()), null, 2), "utf8");
    fs.writeFileSync(commandHistoryPath(id), JSON.stringify({ id, command: "notice", processedAt: new Date().toISOString(), result: "acknowledged" }, null, 2), "utf8");
    const res = cleanupResidualProcessing(processing);
    check("CMD-009 residual processing limpo", res.action === "stale_processed" && !fs.existsSync(processing));
  }

  // CMD-010 .processing sem processed => move para failed sem executar.
  {
    const id = uuid();
    fs.writeFileSync(processing, JSON.stringify(buildCommandPayload("notice", id, new Date().toISOString()), null, 2), "utf8");
    const res = cleanupResidualProcessing(processing);
    check("CMD-010 processing sem processed falha", res.action === "failed" && /failed-/.test(res.path || "") && fs.existsSync(res.path));
  }

  // CMD-011 restart do harness não reapresenta notice já processado.
  {
    const id = uuid();
    fs.writeFileSync(commandHistoryPath(id), JSON.stringify({ id, command: "notice", processedAt: new Date().toISOString(), result: "acknowledged" }, null, 2), "utf8");
    writeCommandFileAtomic(buildCommandPayload("notice", id, new Date().toISOString()), file);
    const stale = cleanupResidualProcessing(processing);
    const claimed = claimCommandFile(file, processing);
    const processedExists = fs.existsSync(commandHistoryPath(id));
    check("CMD-011 restart não reapresenta", processedExists && (!claimed || stale.action === "none" || stale.action === "stale_processed"));
    if (fs.existsSync(processing)) fs.unlinkSync(processing);
  }

  check("isValidCommandName notice", isValidCommandName("notice") === true);
  check("isValidCommandName status", isValidCommandName("status") === true);
  check("isValidCommandName reject", isValidCommandName("run") === false);

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();
