const fs = require("fs");
const path = require("path");

const DEFAULT_MAX_RECORDS = 100;
const TERMINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REJECTED"]);
const LOCAL_STATUSES = new Set(["RUNNING", "SUCCESS", "FAILED", "REJECTED"]);

function shortText(value, max = 2000) {
  if (value == null) return null;
  return String(value).replace(/[\r\n]+/g, " ").slice(0, max);
}

function createRemoteActionStore({ dir, filename = "remote-actions-state.json", maxRecords = DEFAULT_MAX_RECORDS, logEvent = () => {} } = {}) {
  if (!dir) throw new Error("diretorio do storage de ações remotas ausente");
  const file = path.join(dir, filename);
  let records = new Map();

  function report(message) {
    try { logEvent(message); } catch (err) {}
  }

  function normalize(record) {
    if (!record || !record.actionExecutionId || !LOCAL_STATUSES.has(record.status)) return null;
    return {
      actionExecutionId: String(record.actionExecutionId),
      action: String(record.action || "").trim().toLowerCase(),
      status: record.status,
      message: shortText(record.message, 1000),
      error: shortText(record.error, 2000),
      result: TERMINAL_STATUSES.has(record.status) ? (record.result === undefined ? null : record.result) : null,
      startedAt: record.startedAt || null,
      finishedAt: record.finishedAt || null,
      updatedAt: record.updatedAt || new Date().toISOString(),
      confirmedByServer: record.confirmedByServer === true
    };
  }

  function retain() {
    const values = Array.from(records.values()).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    records = new Map(values.slice(0, Math.max(1, Number(maxRecords) || DEFAULT_MAX_RECORDS)).map((item) => [item.actionExecutionId, item]));
  }

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.executions) ? parsed.executions : null;
      if (!list) throw new Error("formato inválido");
      records = new Map(list.map(normalize).filter(Boolean).map((item) => [item.actionExecutionId, item]));
      retain();
    } catch (err) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, quarantine); } catch (renameErr) {}
      records = new Map();
      report(`remote_action_storage_corrupt arquivo=${file} erro=${err.message}`);
    }
  }

  function writeAtomic() {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
    let fd = null;
    try {
      fd = fs.openSync(temp, "w");
      fs.writeFileSync(fd, JSON.stringify({ version: 1, executions: Array.from(records.values()) }, null, 2), "utf8");
      if (typeof fs.fsyncSync === "function") fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try {
        fs.renameSync(temp, file);
      } catch (err) {
        // Windows does not replace an existing destination with rename().
        const backup = `${file}.replace-${process.pid}-${Date.now()}`;
        if (!fs.existsSync(file)) throw err;
        fs.renameSync(file, backup);
        try {
          fs.renameSync(temp, file);
          try { fs.rmSync(backup, { force: true }); } catch (cleanupErr) {}
        } catch (replaceErr) {
          try { fs.renameSync(backup, file); } catch (restoreErr) {}
          throw replaceErr;
        }
      }
      return true;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (err) {}
      }
      try { if (fs.existsSync(temp)) fs.rmSync(temp, { force: true }); } catch (err) {}
    }
  }

  function save() {
    try {
      return writeAtomic();
    } catch (err) {
      report(`remote_action_storage_write_failed arquivo=${file} erro=${err.message}`);
      return false;
    }
  }

  function upsert(record) {
    const normalized = normalize(record);
    if (!normalized) return false;
    records.set(normalized.actionExecutionId, normalized);
    retain();
    return save();
  }

  function get(actionExecutionId) {
    const record = records.get(String(actionExecutionId));
    return record ? { ...record } : null;
  }

  function markConfirmed(actionExecutionId, status) {
    const record = records.get(String(actionExecutionId));
    if (!record || (status && record.status !== status)) return false;
    record.confirmedByServer = true;
    record.updatedAt = new Date().toISOString();
    return save();
  }

  function reconciliationRecords() {
    return Array.from(records.values())
      .filter((record) => record.status === "RUNNING" || (TERMINAL_STATUSES.has(record.status) && !record.confirmedByServer))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((record) => ({ ...record }));
  }

  load();
  return {
    file,
    load,
    save,
    upsert,
    get,
    markConfirmed,
    reconciliationRecords,
    get size() { return records.size; }
  };
}

module.exports = {
  DEFAULT_MAX_RECORDS,
  TERMINAL_STATUSES,
  LOCAL_STATUSES,
  createRemoteActionStore
};
