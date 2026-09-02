const test = require("node:test");
const assert = require("node:assert/strict");
const { sanitizeInventoryRow, partialOfficeKey, normalizeEquipmentNumber } = require("./src/inventory/excelInventory");
const { importAuthorizedBaselines } = require("./src/inventory/baselineImport");
const { compareInventory, compareCpu, compareRam, compareStorage, compareWindows, compareOffice, comparePartialKey, STATUS } = require("./src/inventory/inventoryComparison");

const fullOfficeKey = ["ABCDE", "12345", "FGHIJ", "KLMNO", "PQRST"].join("-");

test("sanitizes Excel row and keeps only an Office partial key", () => {
  const row = sanitizeInventoryRow({ "EQUIP. Nº": " 67. ", PROCESSADOR: "Intel Core i5-8400", " RAM": "8", "SISTEMA OPERACIONAL": "Windows 10", marca: "Lenovo V530S", atual: "Vinicius - Legal", "OBSERVAÇÕES": "SSD 240 GB", "KEY WIN": fullOfficeKey, "OFFICE KEY": fullOfficeKey, OFFICE: "2013 H B" });
  assert.equal(row.equipamentoNumero, "67");
  assert.equal(row.officePartialKeyEsperada, "PQRST");
  assert.equal(Object.values(row).includes(fullOfficeKey), false);
  assert.equal(Object.hasOwn(row, "KEY WIN"), false);
});

test("normalizes equipment formatting and partial keys safely", () => {
  assert.equal(normalizeEquipmentNumber("47."), "47");
  assert.equal(normalizeEquipmentNumber("N77"), null);
  assert.equal(partialOfficeKey("PYQTQ"), "PYQTQ");
  assert.equal(partialOfficeKey(fullOfficeKey), "PQRST");
  assert.equal(partialOfficeKey("too-long-value"), null);
});

test("imports only authorized unique equipment rows", async () => {
  const calls = [];
  const rows = [47, 52, 67, 77, 100].map((number) => ({ equipamentoNumero: String(number), processador: "CPU", ramEsperada: 8, windowsEsperado: "Windows 10", officeEsperado: "2013 H B" }));
  const db = {
    computador: { findMany: async () => [{ id: 165, equipamentoNumero: "47", apelido: "Dani Souto" }, { id: 174, equipamentoNumero: "52", apelido: "Higor" }, { id: 161, equipamentoNumero: "67", apelido: "Vinicius" }] },
    computerInventoryBaseline: { upsert: async (args) => { calls.push(args); return { id: calls.length }; } }
  };
  const result = await importAuthorizedBaselines({ rows, db });
  assert.deepEqual(result.imported.map((item) => item.equipamentoNumero), ["47", "52", "67"]);
  assert.equal(result.imported.some((item) => item.equipamentoNumero === "77"), false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].create.apelidoEsperado, "Dani Souto");
});

test("rejects duplicate authorized Excel rows", async () => {
  const db = { computador: { findMany: async () => [{ id: 165, equipamentoNumero: "47", apelido: null }] }, computerInventoryBaseline: { upsert: async () => ({ id: 1 }) } };
  const result = await importAuthorizedBaselines({ rows: [{ equipamentoNumero: "47" }, { equipamentoNumero: "47" }], db, equipmentNumbers: ["47"] });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, "duplicate_excel_row");
});

test("compares VAVA67 baseline and observed Office", () => {
  const result = compareInventory({ processadorEsperado: "Intel Core i5-8400", ramEsperada: 8, armazenamentoEsperado: "SSD 240 GB", windowsEsperado: "Windows 10 64bits", officeEsperado: "2013 H B", officePartialKeyEsperada: "PYQTQ" }, {
    processador: "Intel(R) Core(TM) i5-8400 CPU @ 2.80GHz", ramTotal: 8477552640, sistema: "win32", sistemaRelease: "10.0.19045", discosFisicos: [{ tamanho: 240054796800, modelo: "SSD" }], officeInstallations: [{ source: "MSI", productName: "Microsoft Office Home and Business 2013", version: "15.0" }, { source: "OSPP", productName: "OfficeHomeBusinessR_Retail", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "PYQTQ" }]
  });
  assert.deepEqual(result.map((item) => item.status), Array(6).fill(STATUS.MATCH));
});

test("supports comparison statuses and technical normalizers", () => {
  assert.equal(compareCpu("i5-8400", "i7-8700").status, STATUS.DIFFERENT);
  assert.equal(compareRam(8, 16 * 1024 ** 3).status, STATUS.DIFFERENT);
  assert.equal(compareStorage("SSD 240 GB", [{ tamanho: 480000000000 }]).status, STATUS.DIFFERENT);
  assert.equal(compareWindows("Windows 10", "win32", "10.0.19045").status, STATUS.MATCH);
  assert.equal(compareOffice("Microsoft 365", "Office 2013").status, STATUS.DIFFERENT);
  assert.equal(comparePartialKey("ABCDE", null).status, STATUS.NO_AGENT_DATA);
  assert.equal(compareInventory(null, {}).every((item) => item.status === STATUS.NO_BASELINE), true);
  assert.equal(compareInventory({ processadorEsperado: "CPU" }, {}).some((item) => item.status === STATUS.NO_AGENT_DATA), true);
});
