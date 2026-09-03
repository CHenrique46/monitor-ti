const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");
const { sanitizeInventoryRow, parseStorageCapacity, partialOfficeKey, normalizeEquipmentNumber, parseCells, readInventoryRows } = require("./src/inventory/excelInventory");
const { importAuthorizedBaselines } = require("./src/inventory/baselineImport");
const { compareInventory, normalizeCpu, compareCpu, compareRam, compareStorage, compareWindows, compareOffice, comparePartialKey, STATUS } = require("./src/inventory/inventoryComparison");
const { createComputadoresController } = require("./src/controllers/computadores.controller");

const fullOfficeKey = ["ABCDE", "12345", "FGHIJ", "KLMNO", "PQRST"].join("-");
const fictitiousOfficeKey = ["ABCDE", "12345", "FGHIJ", "KLMNO", "TFY23"].join("-");

function writeTestWorkbook(filePath) {
  const shared = ["EQUIP. N°", "ARMAZENAMENTO", "OFFICE KEY", "OFFICE", "52", "240 GB", fictitiousOfficeKey, "2013 H B"];
  const sharedXml = `<sst>${shared.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`;
  const sheetXml = '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="G1" t="s"><v>1</v></c><c r="H1"/><c r="I1" t="s"><v>2</v></c><c r="J1" t="s"><v>3</v></c></row><row r="39"><c r="A39" t="s"><v>4</v></c><c r="G39" t="s"><v>5</v></c><c r="H39"/><c r="I39" t="s"><v>6</v></c><c r="J39" t="s"><v>7</v></c></row></sheetData></worksheet>';
  const workbookXml = '<workbook><sheets><sheet name="INVENTARIO" r:id="rId1"/></sheets></workbook>';
  const relationsXml = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  fs.writeFileSync(filePath, Buffer.from(zipSync({
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": strToU8(relationsXml),
    "xl/sharedStrings.xml": strToU8(sharedXml),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml)
  })));
}

test("parses self-closing cells without consuming the next cell", () => {
  const row = parseCells('<c r="H39"/><c r="I39" t="s"><v>0</v></c><c r="J39" t="s"><v>1</v></c>', [fullOfficeKey, "2013 H B"]);
  assert.equal(row.H, "");
  assert.equal(row.I, fullOfficeKey);
  assert.equal(row.J, "2013 H B");
});

test("parses a normal empty cell before a populated cell", () => {
  const row = parseCells('<c r="H39"></c><c r="I39" t="s"><v>0</v></c>', [fullOfficeKey]);
  assert.equal(row.H, "");
  assert.equal(row.I, fullOfficeKey);
});

test("parses consecutive self-closing cells independently", () => {
  const row = parseCells('<c r="H39"/><c r="I39"/><c r="J39" t="s"><v>0</v></c>', ["2013 H B"]);
  assert.equal(row.H, "");
  assert.equal(row.I, "");
  assert.equal(row.J, "2013 H B");
});

test("reads a fictitious Office key partial and storage from an XLSX-shaped row", () => {
  const filePath = path.join(os.tmpdir(), `monitor-ti-inventory-${process.pid}.xlsx`);
  try {
    writeTestWorkbook(filePath);
    const row = readInventoryRows(filePath).find((item) => item.equipamentoNumero === "52");
    assert.equal(row.officePartialKeyEsperada, "TFY23");
    assert.equal(row.armazenamentoEsperado, "240 GB");
    assert.equal(Object.values(row).includes(fictitiousOfficeKey), false);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("sanitizes Excel row and keeps only an Office partial key", () => {
  const row = sanitizeInventoryRow({ "EQUIP. Nº": " 67. ", PROCESSADOR: "Intel Core i5-8400", " RAM": "8", "SISTEMA OPERACIONAL": "Windows 10", marca: "Lenovo V530S", atual: "Vinicius - Legal", "ARMAZENAMENTO": "240 GB", "OBSERVAÇÕES": "SSD comprado 30/08/2022", "KEY WIN": fullOfficeKey, "OFFICE KEY": fullOfficeKey, OFFICE: "2013 H B" });
  assert.equal(row.equipamentoNumero, "67");
  assert.equal(row.officePartialKeyEsperada, "PQRST");
  assert.equal(row.armazenamentoEsperado, "240 GB");
  assert.equal(row.observacoes, "SSD comprado 30/08/2022");
  assert.equal(Object.values(row).includes(fullOfficeKey), false);
  assert.equal(Object.hasOwn(row, "KEY WIN"), false);
});

test("accepts only simple commercial storage capacities", () => {
  assert.equal(parseStorageCapacity("240 GB"), "240 GB");
  assert.equal(parseStorageCapacity("480   gb"), "480 GB");
  assert.equal(parseStorageCapacity("500 GB"), "500 GB");
  assert.equal(parseStorageCapacity("1 TB"), "1 TB");
  assert.equal(parseStorageCapacity("SSD comprado 30/08/2022"), null);
  assert.equal(parseStorageCapacity(""), null);
  assert.equal(parseStorageCapacity("240 GB extra"), null);
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
  const result = compareInventory({ processadorEsperado: "Intel Core i5-8400", ramEsperada: 8, armazenamentoEsperado: "240 GB", windowsEsperado: "Windows 10 64bits", officeEsperado: "2013 H B", officePartialKeyEsperada: "PYQTQ" }, {
    processador: "Intel(R) Core(TM) i5-8400 CPU @ 2.80GHz", ramTotal: 8477552640, sistema: "win32", sistemaRelease: "10.0.19045", discosFisicos: [{ tamanho: 240054796800, modelo: "SSD" }], officeInstallations: [{ source: "MSI", productName: "Microsoft Office Home and Business 2013", version: "15.0" }, { source: "OSPP", productName: "OfficeHomeBusinessR_Retail", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "PYQTQ" }]
  });
  assert.deepEqual(result.map((item) => item.status), Array(6).fill(STATUS.MATCH));
});

test("supports comparison statuses and technical normalizers", () => {
  assert.equal(normalizeCpu("Intel Core I5 4590 3.3ghz"), "i5-4590");
  assert.equal(normalizeCpu("Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz"), "i5-4590");
  assert.equal(compareCpu("Intel Core I5 4590 3.3ghz", "Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz").status, STATUS.MATCH);
  assert.equal(compareCpu("Intel Core i5-4590", "Intel Core i5-6500").status, STATUS.DIFFERENT);
  assert.equal(compareCpu("i5-8400", "i7-8700").status, STATUS.DIFFERENT);
  assert.equal(compareRam(8, 16 * 1024 ** 3).status, STATUS.DIFFERENT);
  assert.equal(compareStorage("240 GB", [{ tamanho: 480000000000 }]).status, STATUS.DIFFERENT);
  assert.equal(compareStorage("240 GB", [{ tamanho: 223 * 1024 ** 3 }]).status, STATUS.MATCH);
  assert.equal(compareStorage("SSD comprado 30/08/2022", [{ tamanho: 240000000000 }]).status, STATUS.NOT_COMPARABLE);
  assert.equal(compareWindows("Windows 10", "win32", "10.0.19045").status, STATUS.MATCH);
  assert.equal(compareOffice("Microsoft 365", "Office 2013").status, STATUS.DIFFERENT);
  assert.equal(comparePartialKey("ABCDE", null).status, STATUS.NO_AGENT_DATA);
  assert.equal(compareInventory(null, {}).every((item) => item.status === STATUS.NO_BASELINE), true);
  assert.equal(compareInventory({ processadorEsperado: "CPU" }, {}).some((item) => item.status === STATUS.NO_AGENT_DATA), true);
});

test("controller serves the inventory comparison service payload", async () => {
  const calls = [];
  const controller = createComputadoresController({ service: {
    getInventoryComparison: async (id) => {
      calls.push(id);
      return { baseline: { computadorId: 161 }, comparison: [{ field: "CPU", status: STATUS.MATCH }] };
    }
  } });
  const response = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.getInventoryComparison({ params: { id: "161" } }, response);
  assert.equal(response.code, 200);
  assert.deepEqual(response.body, { baseline: { computadorId: 161 }, comparison: [{ field: "CPU", status: STATUS.MATCH }] });
  assert.deepEqual(calls, ["161"]);
});
