const { enqueueExcelSync } = require("./excelSyncOutbox");
const { snapshotFromComputer } = require("./excelSyncSnapshot");

async function queueComputerInventorySync({ db, computadorId, includeOffice = false, includeStorage = true, mergeWithLatest = true, log = () => {} } = {}) {
  try {
    const computer = await db.computador.findUnique({
      where: { id: Number(computadorId) },
      include: {
        discosFisicos: true,
        officeInstallations: { where: { isPresent: true }, orderBy: { id: "asc" } },
        inventoryBaseline: true
      }
    });
    if (!computer || !computer.equipamentoNumero || !computer.inventoryBaseline) return { queued: false, reason: "not_associated" };
    const snapshot = snapshotFromComputer(computer, { includeOffice, includeStorage });
    if (!snapshot) return { queued: false, reason: "insufficient_snapshot" };
    const sync = await enqueueExcelSync({
      db,
      computerId: computer.id,
      baselineId: computer.inventoryBaseline.id,
      equipamentoNumero: computer.equipamentoNumero,
      snapshot,
      mergeWithLatest
    });
    return { queued: true, sync };
  } catch (error) {
    log(`Excel inventory auto-sync skipped: ${String(error && error.message || error).slice(0, 240)}`);
    return { queued: false, reason: "error" };
  }
}

module.exports = { queueComputerInventorySync };
