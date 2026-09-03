const SYNC_OPERATION = "UPSERT_INVENTORY";
const PENDING = "PENDING";

async function enqueueExcelSync({ db, computerId, baselineId, equipamentoNumero, forceNewRun = false } = {}) {
  if (!db || !computerId || !baselineId || !equipamentoNumero) throw new Error("Dados da sincronização Excel inválidos.");
  const active = await db.excelInventorySync.findFirst({
    where: { baselineId, operation: SYNC_OPERATION, status: { in: ["PENDING", "PROCESSING"] } },
    orderBy: { id: "asc" }
  });
  if (active) return active;
  if (!forceNewRun) {
    const latest = await db.excelInventorySync.findFirst({ where: { baselineId, operation: SYNC_OPERATION }, orderBy: { id: "desc" } });
    if (latest && latest.status === "SYNCED") return latest;
  }
  try {
    return await db.excelInventorySync.create({
      data: { computerId, baselineId, equipamentoNumero: String(equipamentoNumero), operation: SYNC_OPERATION, status: PENDING }
    });
  } catch (error) {
    if (error && error.code === "P2002") {
      return db.excelInventorySync.findFirst({ where: { baselineId, operation: SYNC_OPERATION, status: { in: ["PENDING", "PROCESSING"] } }, orderBy: { id: "asc" } });
    }
    throw error;
  }
}

module.exports = { SYNC_OPERATION, PENDING, enqueueExcelSync };
