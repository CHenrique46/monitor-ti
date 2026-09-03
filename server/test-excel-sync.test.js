const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strFromU8, strToU8, unzipSync } = require("fflate");
const { readInventoryRows } = require("./src/inventory/excelInventory");
const { ExcelSyncError, syncBaselineToExcel, transformWorkbook, baselineValues } = require("./src/inventory/excelSyncWriter");
const { enqueueExcelSync } = require("./src/inventory/excelSyncOutbox");
const { createExcelSyncWorker } = require("./src/inventory/excelSyncWorker");

const fakeFullSame = "AAAAA-BBBBB-CCCCC-DDDDD-DV3TM";
const fakeFullDifferent = "AAAAA-BBBBB-CCCCC-DDDDD-XXXXX";

function baseline(overrides = {}) {
  return {
    id: 9,
    computadorId: 162,
    equipamentoNumero: "77",
    apelidoEsperado: "Sheila",
    processadorEsperado: "Intel(R) Core(TM) i5-14500",
    ramEsperada: 15.7,
    armazenamentoEsperado: "512 GB",
    windowsEsperado: "10.0.26200",
    officeEsperado: "Microsoft Office Home and Business 2013 - pt-br",
    officePartialKeyEsperada: "DV3TM",
    ...overrides
  };
}

function fixture({ office = "empty", user = "Sheila - Fiscal", duplicate = false } = {}) {
  const shared = ["EQUIP. N°", "PROCESSADOR", " RAM", "SISTEMA OPERACIONAL", "marca", "atual", "ARMAZENAMENTO", "KEY WIN", "OFFICE KEY", "OFFICE", "77", "Intel Core old", "8 GB", "Windows old", "LEGACY-MARKER", "WIN-FIXTURE", "512 GB", "2013 H B", "DV3TM", fakeFullSame, fakeFullDifferent, "ZZZZZ"];
  const s = (index, ref) => `<c r="${ref}" t="s"><v>${index}</v></c>`;
  const empty = (ref) => `<c r="${ref}"/>`;
  const officeCell = office === "empty" ? empty("I2") : office === "partial" ? s(18, "I2") : office === "full-same" ? s(19, "I2") : office === "full-different" ? s(20, "I2") : s(21, "I2");
  const userCell = user === "" ? empty("F2") : `<c r="F2" t="inlineStr"><is><t>${user}</t></is></c>`;
  const row = `<row r="2">${s(10, "A2")}${s(11, "B2")}${s(12, "C2")}${s(13, "D2")}${s(14, "E2")}${userCell}${s(16, "G2")}${s(15, "H2")}${officeCell}${s(17, "J2")}</row>`;
  const rows = `<row r="1">${s(0, "A1")}${s(1, "B1")}${s(2, "C1")}${s(3, "D1")}${s(4, "E1")}${s(5, "F1")}${s(6, "G1")}${s(7, "H1")}${s(8, "I1")}${s(9, "J1")}</row>${row}${duplicate ? row.replaceAll("2", "3") : ""}`;
  const files = {
    "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="INVENTARIO" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/sharedStrings.xml": strToU8(`<sst>${shared.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)
  };
  return Buffer.from(zipSync(files));
}

function tempWorkbook(options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ti-excel-sync-"));
  const filePath = path.join(directory, "inventario.xlsx");
  fs.writeFileSync(filePath, fixture(options));
  return { directory, filePath, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("writes only the target row, preserves atual/marca/KEY WIN and keeps workbook readable", () => {
  const temp = tempWorkbook({ office: "empty" });
  try {
    const result = syncBaselineToExcel({ baseline: baseline(), filePath: temp.filePath, backupDir: path.join(temp.directory, "backups"), now: () => new Date("2026-09-03T15:00:00.000Z") });
    const row = readInventoryRows(temp.filePath).find((item) => item.equipamentoNumero === "77");
    assert.equal(result.status, "SYNCED");
    assert.equal(row.processador, "Intel Core i5-14500");
    assert.equal(row.ramEsperada, 16);
    assert.equal(row.armazenamentoEsperado, "512 GB");
    assert.equal(row.windowsEsperado, "10.0.26200");
    assert.equal(row.officeEsperado, "2013 H B");
    assert.equal(row.officePartialKeyEsperada, "DV3TM");
    assert.equal(row.apelidoEsperado, "Sheila - Fiscal");
    assert.equal(fs.existsSync(result.backupPath), true);
    const xml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(temp.filePath)))["xl/worksheets/sheet1.xml"]);
    assert.equal(row.fabricanteModeloEsperado, "LEGACY-MARKER");
    assert.equal(row.observacoes, null);
    assert.equal(xml.includes('r="E2"'), true);
    assert.equal(xml.includes('r="H2"'), true);
  } finally { temp.cleanup(); }
});

test("preserves equal partial/full Office keys and rejects conflicts or invalid values", () => {
  for (const office of ["partial", "full-same"]) {
    const temp = tempWorkbook({ office });
    try { assert.equal(syncBaselineToExcel({ baseline: baseline(), filePath: temp.filePath, backupDir: path.join(temp.directory, "backups") }).status, "SYNCED"); } finally { temp.cleanup(); }
  }
  for (const office of ["full-different", "invalid"]) {
    const temp = tempWorkbook({ office });
    const before = fs.readFileSync(temp.filePath);
    try { assert.throws(() => syncBaselineToExcel({ baseline: baseline(), filePath: temp.filePath, backupDir: path.join(temp.directory, "backups") }), (error) => error instanceof ExcelSyncError && error.code === "OFFICE_KEY_CONFLICT"); assert.deepEqual(fs.readFileSync(temp.filePath), before); } finally { temp.cleanup(); }
  }
});

test("preserves a non-empty atual and fills an empty atual from the approved nickname", () => {
  const existing = tempWorkbook({ office: "empty", user: "Sheila - Fiscal" });
  const empty = tempWorkbook({ office: "empty", user: "" });
  try {
    syncBaselineToExcel({ baseline: baseline(), filePath: existing.filePath, backupDir: path.join(existing.directory, "backups") });
    syncBaselineToExcel({ baseline: baseline(), filePath: empty.filePath, backupDir: path.join(empty.directory, "backups") });
    assert.equal(readInventoryRows(existing.filePath).find((row) => row.equipamentoNumero === "77").apelidoEsperado, "Sheila - Fiscal");
    assert.equal(readInventoryRows(empty.filePath).find((row) => row.equipamentoNumero === "77").apelidoEsperado, "Sheila");
  } finally { existing.cleanup(); empty.cleanup(); }
});

test("rejects missing and duplicate inventory rows before replacing the original", () => {
  const missing = tempWorkbook({ office: "empty" });
  try { assert.throws(() => transformWorkbook(fixture({ office: "empty" }), baseline({ equipamentoNumero: "99" })), /não encontrado/); } finally { missing.cleanup(); }
  const duplicate = tempWorkbook({ office: "empty", duplicate: true });
  const before = fs.readFileSync(duplicate.filePath);
  try { assert.throws(() => syncBaselineToExcel({ baseline: baseline(), filePath: duplicate.filePath, backupDir: path.join(duplicate.directory, "backups") }), /duplicadas/); assert.deepEqual(fs.readFileSync(duplicate.filePath), before); } finally { duplicate.cleanup(); }
});

test("rejects an existing lock without touching the original", () => {
  const temp = tempWorkbook({ office: "empty" });
  const before = fs.readFileSync(temp.filePath);
  try { fs.writeFileSync(`${temp.filePath}.lock`, "held"); assert.throws(() => syncBaselineToExcel({ baseline: baseline(), filePath: temp.filePath }), (error) => error.code === "EXCEL_LOCKED"); assert.deepEqual(fs.readFileSync(temp.filePath), before); } finally { temp.cleanup(); }
});

test("outbox references a baseline and never stores key or Windows data", async () => {
  const calls = [];
  const db = { excelInventorySync: { findFirst: async () => null, create: async (args) => { calls.push(args); return args.data; } } };
  await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77" });
  assert.deepEqual(calls[0].data, { computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "PENDING" });
  assert.equal(JSON.stringify(calls[0]).includes(fakeFullSame), false);
  assert.equal(JSON.stringify(calls[0]).includes("Windows"), false);
});

function outboxDb(initial = []) {
  const items = [...initial];
  return {
    items,
    excelInventorySync: {
      findFirst: async ({ where }) => items.filter((item) => item.baselineId === where.baselineId && item.operation === where.operation && (!where.status || where.status.in.includes(item.status))).sort((a, b) => b.id - a.id)[0] || null,
      create: async ({ data }) => {
        if (items.some((item) => item.baselineId === data.baselineId && item.operation === data.operation && ["PENDING", "PROCESSING"].includes(item.status))) { const error = new Error("active duplicate"); error.code = "P2002"; throw error; }
        const item = { ...data, id: items.length + 1 };
        items.push(item);
        return item;
      }
    }
  };
}

test("outbox keeps one active run and preserves completed history", async () => {
  const db = outboxDb();
  const first = await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77" });
  const duplicate = await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77" });
  assert.equal(db.items.length, 1);
  assert.equal(duplicate.id, first.id);
  db.items[0].status = "PROCESSING";
  assert.equal((await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77" })).id, first.id);
  db.items[0].status = "SYNCED";
  const resync = await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77", forceNewRun: true });
  assert.equal(resync.id, 2);
  assert.equal(db.items[0].status, "SYNCED");
  assert.equal(db.items.length, 2);
});

test("outbox retries FAILED with a new explicit run and protects concurrent requests", async () => {
  const db = outboxDb([{ id: 1, baselineId: 9, operation: "UPSERT_INVENTORY", status: "FAILED" }]);
  const retry = await enqueueExcelSync({ db, computerId: 162, baselineId: 9, equipamentoNumero: "77", forceNewRun: true });
  assert.equal(retry.id, 2);
  assert.equal(db.items[0].status, "FAILED");
  const concurrentDb = outboxDb();
  const results = await Promise.all([
    enqueueExcelSync({ db: concurrentDb, computerId: 162, baselineId: 9, equipamentoNumero: "77", forceNewRun: true }),
    enqueueExcelSync({ db: concurrentDb, computerId: 162, baselineId: 9, equipamentoNumero: "77", forceNewRun: true })
  ]);
  assert.equal(concurrentDb.items.filter((item) => ["PENDING", "PROCESSING"].includes(item.status)).length, 1);
  assert.equal(new Set(results.map((item) => item.id)).size, 1);
});

test("normalizes baseline presentation for Excel", () => {
  const values = baselineValues(baseline());
  assert.equal(values.B, "Intel Core i5-14500");
  assert.equal(values.C, "16 GB");
  assert.equal(values.G, "512 GB");
  assert.equal(values.J, "2013 H B");
  assert.equal(values.I, "DV3TM");
});

test("worker claims, syncs, retries and recovers abandoned processing items", async () => {
  const now = new Date("2026-09-03T15:00:00.000Z");
  const state = { item: { id: 1, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "PENDING", attempts: 0, nextAttemptAt: now }, baseline: baseline(), updates: [] };
  const db = {
    $transaction: async (work) => work({ excelInventorySync: { findFirst: async () => state.item.status === "PENDING" ? state.item : null, updateMany: async ({ data }) => { Object.assign(state.item, data, { attempts: state.item.attempts + (data.attempts ? 1 : 0) }); return { count: 1 }; } } }),
    excelInventorySync: { update: async ({ data }) => { Object.assign(state.item, data); state.updates.push(data); return state.item; }, updateMany: async () => ({ count: 0 }) },
    computerInventoryBaseline: { findUnique: async () => state.baseline }
  };
  let writes = 0;
  const worker = createExcelSyncWorker({ db, writer: async () => { writes++; }, now: () => now });
  assert.equal((await worker.processNext()).status, "SYNCED");
  assert.equal(writes, 1);
  assert.equal(state.item.status, "SYNCED");
  state.item.status = "PROCESSING"; state.item.leaseUntil = new Date(now.getTime() - 1); state.item.attempts = 1;
  db.excelInventorySync.updateMany = async ({ data }) => { Object.assign(state.item, data); return { count: 1 }; };
  assert.equal((await worker.recoverAbandoned()).count, 1);
  assert.equal(state.item.status, "PENDING");
});
