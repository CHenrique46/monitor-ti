const { readInventoryRows } = require("./excelInventory");

const AUTHORIZED_EQUIPMENT_NUMBERS = ["47", "52", "67"];

function toBaseline(row, computer) {
  return {
    computadorId: computer.id,
    equipamentoNumero: row.equipamentoNumero,
    apelidoEsperado: computer.apelido || row.apelidoEsperado || null,
    processadorEsperado: row.processador,
    ramEsperada: row.ramEsperada,
    armazenamentoEsperado: row.armazenamentoEsperado,
    windowsEsperado: row.windowsEsperado,
    officeEsperado: row.officeEsperado,
    officePartialKeyEsperada: row.officePartialKeyEsperada,
    fabricanteModeloEsperado: row.fabricanteModeloEsperado,
    observacoes: row.observacoes || null,
    source: "EXCEL_IMPORT"
  };
}

async function importAuthorizedBaselines({ rows, filePath, db, equipmentNumbers = AUTHORIZED_EQUIPMENT_NUMBERS } = {}) {
  const input = rows || readInventoryRows(filePath);
  const allowed = equipmentNumbers.map(String);
  const selected = new Map();
  const duplicate = new Set();
  for (const row of input) {
    if (!row || !allowed.includes(String(row.equipamentoNumero))) continue;
    const number = String(row.equipamentoNumero);
    if (selected.has(number)) duplicate.add(number);
    else selected.set(number, row);
  }
  const computers = await db.computador.findMany({ where: { equipamentoNumero: { in: allowed } }, select: { id: true, equipamentoNumero: true, apelido: true } });
  const byNumber = new Map(computers.map((computer) => [computer.equipamentoNumero, computer]));
  const imported = [];
  const skipped = [];
  for (const number of allowed) {
    if (duplicate.has(number) || !selected.has(number) || !byNumber.has(number)) {
      skipped.push({ equipamentoNumero: number, reason: duplicate.has(number) ? "duplicate_excel_row" : !selected.has(number) ? "missing_excel_row" : "computer_not_linked" });
      continue;
    }
    const data = toBaseline(selected.get(number), byNumber.get(number));
    const baseline = await db.computerInventoryBaseline.upsert({ where: { computadorId: data.computadorId }, create: data, update: data });
    imported.push({ equipamentoNumero: number, computadorId: data.computadorId, baselineId: baseline.id });
  }
  return { imported, skipped };
}

module.exports = { AUTHORIZED_EQUIPMENT_NUMBERS, toBaseline, importAuthorizedBaselines };
