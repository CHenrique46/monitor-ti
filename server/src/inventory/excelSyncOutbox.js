const SYNC_OPERATION = "UPSERT_INVENTORY";
const PENDING = "PENDING";

async function enqueueExcelSync({ db, computerId, baselineId, equipamentoNumero } = {}) {
  if (!db || !computerId || !baselineId || !equipamentoNumero) throw new Error("Dados da sincronização Excel inválidos.");
  try {
    return await db.excelInventorySync.create({
      data: { computerId, baselineId, equipamentoNumero: String(equipamentoNumero), operation: SYNC_OPERATION, status: PENDING }
    });
  } catch (error) {
    if (error && error.code === "P2002") return db.excelInventorySync.findUnique({ where: { baselineId } });
    throw error;
  }
}

module.exports = { SYNC_OPERATION, PENDING, enqueueExcelSync };
