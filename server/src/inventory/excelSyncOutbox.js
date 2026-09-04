const SYNC_OPERATION = "UPSERT_INVENTORY";
const PENDING = "PENDING";

const { mergeSnapshots, snapshotsEqual } = require("./excelSyncSnapshot");

async function enqueueExcelSync({ db, computerId, baselineId, equipamentoNumero, snapshot = null, mergeWithLatest = true, forceNewRun = false } = {}) {
  if (!db || !computerId || !baselineId || !equipamentoNumero) throw new Error("Dados da sincronização Excel inválidos.");
  const active = await db.excelInventorySync.findFirst({
    where: { baselineId, operation: SYNC_OPERATION, status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { id: "asc" }
  });
  if (active) {
    if (snapshot && !snapshotsEqual(active.snapshot, snapshot) && db.excelInventorySync.update) {
      return db.excelInventorySync.update({ where: { id: active.id }, data: { snapshot: mergeSnapshots(active.snapshot, snapshot) } });
    }
    return active;
  }
  let latest = null;
  if (snapshot || !forceNewRun) {
    latest = await db.excelInventorySync.findFirst({ where: { baselineId, operation: SYNC_OPERATION }, orderBy: { id: "desc" } });
  }
  if (!forceNewRun) {
    if (latest && latest.status === "SYNCED" && (!snapshot || snapshotsEqual(latest.snapshot, snapshot))) return latest;
  }
  try {
    const data = { computerId, baselineId, equipamentoNumero: String(equipamentoNumero), operation: SYNC_OPERATION, status: PENDING };
    if (snapshot) data.snapshot = mergeWithLatest ? mergeSnapshots(latest?.snapshot, snapshot) : snapshot;
    return await db.excelInventorySync.create({
      data
    });
  } catch (error) {
    if (error && error.code === "P2002") {
      return db.excelInventorySync.findFirst({ where: { baselineId, operation: SYNC_OPERATION, status: { in: ["PENDING", "PROCESSING"] } }, orderBy: { id: "asc" } });
    }
    throw error;
  }
}

module.exports = { SYNC_OPERATION, PENDING, enqueueExcelSync };
