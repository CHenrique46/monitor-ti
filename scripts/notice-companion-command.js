const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIAG_DIR = "C:\\ProgramData\\MonitorTI\\diag";
const COMMAND_FILE = path.join(DIAG_DIR, "companion-command.json");
const PROCESSING_FILE = path.join(DIAG_DIR, "companion-command.processing");
const PROCESSING_SUFFIX = ".processing";
const PROCESSED_SUFFIX = ".processed";
const FAILED_PREFIX = "failed-";
const VALID_COMMANDS = new Set(["notice", "status"]);

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function ensureDiagDir() {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  return DIAG_DIR;
}

function getProcessingFilePath() {
  return PROCESSING_FILE;
}

function getFailedFilePath(id) {
  return path.join(DIAG_DIR, FAILED_PREFIX + String(id || "unknown") + ".json");
}

function isValidCommandName(command) {
  return VALID_COMMANDS.has(String(command || "").trim().toLowerCase());
}

function buildCommandPayload(command, id, createdAt = new Date().toISOString()) {
  return {
    command: String(command || "").trim().toLowerCase(),
    id: String(id || "").trim(),
    createdAt: String(createdAt || "").trim()
  };
}

function validateCommandPayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "payload inválido" };
  if (!isValidCommandName(payload.command)) return { ok: false, reason: "command desconhecido" };
  if (!payload.id || !/^[a-f0-9-]{36}$/i.test(String(payload.id))) return { ok: false, reason: "id inválido" };
  if (!payload.createdAt || Number.isNaN(Date.parse(payload.createdAt))) return { ok: false, reason: "createdAt inválido" };
  return { ok: true, value: buildCommandPayload(payload.command, payload.id, payload.createdAt) };
}

function writeCommandFileAtomic(payload, targetFile = COMMAND_FILE) {
  ensureDiagDir();
  const validated = validateCommandPayload(payload);
  if (!validated.ok) throw new Error(validated.reason);
  const tmp = targetFile + "." + process.pid + "." + Date.now() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(validated.value, null, 2), "utf8");
  fs.renameSync(tmp, targetFile);
  return targetFile;
}

function claimCommandFile(targetFile = COMMAND_FILE, processingFile = PROCESSING_FILE) {
  ensureDiagDir();
  if (!fs.existsSync(targetFile)) return null;
  const tmpProcessing = String(processingFile || PROCESSING_FILE);
  if (fs.existsSync(tmpProcessing)) return null;
  try {
    fs.renameSync(targetFile, tmpProcessing);
    return tmpProcessing;
  } catch {
    return null;
  }
}

function readCommandFile(targetFile = COMMAND_FILE) {
  try {
    if (!fs.existsSync(targetFile)) return null;
    const raw = fs.readFileSync(targetFile, "utf8");
    if (!raw || !String(raw).trim()) return { partial: true };
    const payload = JSON.parse(raw);
    const validated = validateCommandPayload(payload);
    if (!validated.ok) return { invalid: true, reason: validated.reason };
    return { value: validated.value };
  } catch (err) {
    const raw = (() => {
      try { return fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : ""; } catch { return ""; }
    })();
    const trimmed = String(raw || "").trim();
    if (!trimmed || /[,\[{:]$/.test(trimmed)) return { partial: true };
    if (String(err && err.message || "").toLowerCase().includes("unexpected end")) return { partial: true };
    return { invalid: true, reason: err.message };
  }
}

function archiveCommandFile(targetFile = COMMAND_FILE, suffix = PROCESSING_SUFFIX) {
  try {
    if (!fs.existsSync(targetFile)) return null;
    const archived = targetFile.replace(/\.json$/i, suffix + ".json");
    fs.renameSync(targetFile, archived);
    return archived;
  } catch {
    return null;
  }
}

function readProcessingCommandFile(targetFile = PROCESSING_FILE) {
  if (!fs.existsSync(targetFile)) return null;
  return readCommandFile(targetFile);
}

function finalizeProcessingFile(payload, result = "acknowledged", processingFile = PROCESSING_FILE) {
  if (!payload || !payload.id) return null;
  const processingPath = String(processingFile || PROCESSING_FILE);
  const processedPath = commandHistoryPath(payload.id);
  const record = {
    id: payload.id,
    command: payload.command,
    processedAt: new Date().toISOString(),
    result
  };
  try {
    fs.writeFileSync(processedPath, JSON.stringify(record, null, 2), "utf8");
  } catch {
    return null;
  }
  try {
    if (fs.existsSync(processingPath)) fs.unlinkSync(processingPath);
  } catch {
    // best-effort cleanup
  }
  return processedPath;
}

function cleanupResidualProcessing(processingFile = PROCESSING_FILE) {
  const processingPath = String(processingFile || PROCESSING_FILE);
  if (!fs.existsSync(processingPath)) return { action: "none" };
  const state = readProcessingCommandFile(processingPath);
  if (!state || state.partial) {
    try {
      const failedPath = path.join(DIAG_DIR, FAILED_PREFIX + "partial-" + Date.now() + ".json");
      fs.renameSync(processingPath, failedPath);
      return { action: "failed", path: failedPath, reason: "partial" };
    } catch {
      return { action: "failed", reason: "partial" };
    }
  }
  const processedPath = commandHistoryPath(state.value.id);
  if (fs.existsSync(processedPath)) {
    try { fs.unlinkSync(processingPath); } catch {}
    return { action: "stale_processed", id: state.value.id };
  }
  try {
    const failedPath = getFailedFilePath(state.value.id);
    fs.renameSync(processingPath, failedPath);
    return { action: "failed", path: failedPath, id: state.value.id, reason: "interrupted" };
  } catch {
    return { action: "failed", id: state.value.id, reason: "interrupted" };
  }
}

function removeCommandFile(targetFile = COMMAND_FILE) {
  try {
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    return true;
  } catch {
    return false;
  }
}

function commandHistoryPath(id) {
  ensureDiagDir();
  return path.join(DIAG_DIR, "processed-" + id + ".json");
}

function markProcessed(payload) {
  if (!payload || !payload.id) return null;
  const p = commandHistoryPath(payload.id);
  try {
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), "utf8");
    return p;
  } catch {
    return null;
  }
}

function createCommandGate() {
  const seenIds = new Set();
  return {
    seenIds,
    shouldProcess(id) {
      const value = String(id || "").trim();
      if (!value || seenIds.has(value)) return false;
      seenIds.add(value);
      return true;
    },
    reset(id) {
      if (id) seenIds.delete(String(id).trim());
    }
  };
}

module.exports = {
  DIAG_DIR,
  COMMAND_FILE,
  PROCESSING_FILE,
  PROCESSING_SUFFIX,
  PROCESSED_SUFFIX,
  FAILED_PREFIX,
  VALID_COMMANDS,
  uuid,
  ensureDiagDir,
  getProcessingFilePath,
  getFailedFilePath,
  isValidCommandName,
  buildCommandPayload,
  validateCommandPayload,
  writeCommandFileAtomic,
  claimCommandFile,
  readCommandFile,
  readProcessingCommandFile,
  archiveCommandFile,
  removeCommandFile,
  finalizeProcessingFile,
  cleanupResidualProcessing,
  commandHistoryPath,
  markProcessed,
  createCommandGate
};
