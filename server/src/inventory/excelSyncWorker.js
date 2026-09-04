const { getInventoryExcelPath } = require("../config");
const { syncBaselineToExcel } = require("./excelSyncWriter");
const { SYNC_OPERATION } = require("./excelSyncOutbox");

const PROCESSING = "PROCESSING";
const PENDING = "PENDING";
const SYNCED = "SYNCED";
const FAILED = "FAILED";

function createExcelSyncWorker({ db, writer = syncBaselineToExcel, filePath = getInventoryExcelPath(), now = () => new Date(), leaseMs = 5 * 60 * 1000, baseBackoffMs = 30 * 1000, maxAttempts = 5, log = () => {} } = {}) {
  if (!db) throw new Error("Database é obrigatória para o worker Excel.");
  let timer = null;
  let running = false;

  function safeNow() { return now() instanceof Date ? now() : new Date(now()); }

  async function recoverAbandoned() {
    const current = safeNow();
    return db.excelInventorySync.updateMany({ where: { status: PROCESSING, leaseUntil: { lt: current } }, data: { status: PENDING, leaseUntil: null, nextAttemptAt: current, lastError: "PROCESSING lease expirado; item devolvido para retry." } });
  }

  async function claimNext() {
    const current = safeNow();
    return db.$transaction(async (tx) => {
      const candidate = await tx.excelInventorySync.findFirst({ where: { operation: SYNC_OPERATION, status: PENDING, nextAttemptAt: { lte: current } }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }] });
      if (!candidate) return null;
      const claimed = await tx.excelInventorySync.updateMany({ where: { id: candidate.id, status: PENDING }, data: { status: PROCESSING, attempts: { increment: 1 }, leaseUntil: new Date(current.getTime() + leaseMs) } });
      if (claimed.count !== 1) return null;
      return { ...candidate, attempts: candidate.attempts + 1 };
    });
  }

  async function processNext() {
    if (running) return { status: "BUSY" };
    running = true;
    try {
      await recoverAbandoned();
      const item = await claimNext();
      if (!item) return { status: "IDLE" };
      try {
        const baseline = await db.computerInventoryBaseline.findUnique({ where: { id: item.baselineId } });
        if (!baseline || String(baseline.equipamentoNumero) !== String(item.equipamentoNumero)) throw new Error("Baseline referenciado não encontrado ou divergente.");
        await writer({ baseline, snapshot: item.snapshot, filePath });
        await db.excelInventorySync.update({ where: { id: item.id }, data: { status: SYNCED, processedAt: safeNow(), leaseUntil: null, lastError: null } });
        return { status: SYNCED, id: item.id };
      } catch (error) {
        const current = safeNow();
        const exhausted = item.attempts >= maxAttempts;
        const delay = baseBackoffMs * (2 ** Math.max(0, item.attempts - 1));
        const data = { status: exhausted ? FAILED : PENDING, nextAttemptAt: new Date(current.getTime() + (exhausted ? 0 : delay)), leaseUntil: null, lastError: sanitizeError(error), ...(exhausted ? { processedAt: current } : {}) };
        await db.excelInventorySync.update({ where: { id: item.id }, data });
        return { status: data.status, id: item.id };
      }
    } finally { running = false; }
  }

  function sanitizeError(error) {
    return `${error?.code || "EXCEL_SYNC_FAILED"}: ${String(error?.message || "Falha na sincronização").replace(/[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}/g, "[redacted]").slice(0, 240)}`;
  }

  function start(intervalMs = 30 * 1000) {
    if (timer) return;
    timer = setInterval(() => processNext().catch((error) => log(`Excel sync worker error: ${sanitizeError(error)}`)), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { claimNext, processNext, recoverAbandoned, start, stop, sanitizeError };
}

module.exports = { PROCESSING, PENDING, SYNCED, FAILED, createExcelSyncWorker };
