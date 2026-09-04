const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strFromU8, strToU8, unzipSync } = require("fflate");
const { queueComputerInventorySync } = require("./src/inventory/excelAutoSync");
const { snapshotFromComputer, snapshotsEqual } = require("./src/inventory/excelSyncSnapshot");
const { syncBaselineToExcel } = require("./src/inventory/excelSyncWriter");
const { readInventoryRows } = require("./src/inventory/excelInventory");

function computer(overrides = {}) {
  return {
    id: 162,
    equipamentoNumero: "77",
    processador: "Intel(R) Core(TM) i5-14500 CPU @ 2.60GHz",
    ramTotal: 16 * 1024 ** 3,
    sistemaRelease: "10.0.26200",
    discosFisicos: [{ tamanho: 512 * 1e9 }],
    officeInstallations: [{ source: "CLICK_TO_RUN", productReleaseId: "Office2013HomeBusiness", productName: "Office 2013 Home and Business", version: "15.0", partialProductKey: null, fingerprint: "product" }, { source: "OSPP", productName: "Office 2013 Home and Business", licenseName: "Office 2013", licenseDescription: "RETAIL", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "DV3TM", fingerprint: "license" }],
    inventoryBaseline: { id: 9, equipamentoNumero: "77" },
    ...overrides
  };
}

function outboxDb(initial = [], itemComputer = computer()) {
  const items = [...initial];
  return {
    items,
    computador: { findUnique: async () => itemComputer },
    excelInventorySync: {
      findFirst: async ({ where }) => items.filter((item) => item.baselineId === where.baselineId && item.operation === where.operation && (!where.status || where.status.in.includes(item.status))).sort((a, b) => b.id - a.id)[0] || null,
      create: async ({ data }) => { const item = { ...data, id: items.length + 1 }; items.push(item); return item; },
      update: async ({ where, data }) => { const item = items.find((entry) => entry.id === where.id); Object.assign(item, data); return item; }
    }
  };
}

function baseline() {
  return { equipamentoNumero: "77", processadorEsperado: "old CPU", ramEsperada: 8, armazenamentoEsperado: "240 GB", windowsEsperado: "Windows 10", officeEsperado: "2013 H B", officePartialKeyEsperada: "DV3TM" };
}

test("nenhuma mudança não cria nova sincronização", async () => {
  const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "SYNCED", snapshot: snapshotFromComputer(computer()) }]);
  await queueComputerInventorySync({ db, computadorId: 162 });
  await queueComputerInventorySync({ db, computadorId: 162 });
  assert.equal(db.items.length, 1);
});

test("duas notificações Office iguais seguidas não duplicam sincronização", async () => {
  const current = computer();
  const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "SYNCED", snapshot: snapshotFromComputer(current, { includeOffice: true }) }], current);
  await queueComputerInventorySync({ db, computadorId: 162, includeOffice: true });
  await queueComputerInventorySync({ db, computadorId: 162, includeOffice: true });
  assert.equal(db.items.length, 1);
});

test("reconexão sem mudança não gera nova sincronização", async () => {
  const current = computer();
  const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "SYNCED", snapshot: snapshotFromComputer(current) }], current);
  await queueComputerInventorySync({ db, computadorId: 162 });
  assert.equal(db.items.length, 1);
});

test("snapshot de metrics não carrega armazenamento durante register concorrente", async () => {
  const current = computer();
  const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "SYNCED", snapshot: snapshotFromComputer(current, { includeOffice: true }) }], current);
  current.discosFisicos = [{ tamanho: 1000 * 1e9 }];
  current.ramTotal = 32 * 1024 ** 3;
  await queueComputerInventorySync({ db, computadorId: 162, includeStorage: false, mergeWithLatest: false });
  assert.equal(db.items.length, 2);
  assert.equal(db.items[1].snapshot.values.G, undefined);
  assert.equal(db.items[1].snapshot.values.C, "32 GB");
});

for (const [label, change] of [
  ["RAM", (c) => ({ ...c, ramTotal: 32 * 1024 ** 3 })],
  ["processador", (c) => ({ ...c, processador: "Intel Core i7-14700" })],
  ["Windows", (c) => ({ ...c, sistemaRelease: "11.0.26100" })],
  ["armazenamento", (c) => ({ ...c, discosFisicos: [{ tamanho: 1000 * 1e9 }] })],
  ["Office", (c) => ({ ...c, officeInstallations: [{ ...c.officeInstallations[0], productName: "Microsoft 365 Apps" }] })],
  ["Office key parcial", (c) => ({ ...c, officeInstallations: c.officeInstallations.map((item) => item.source === "OSPP" ? { ...item, partialProductKey: "ABCDE" } : item) })]
]) {
  test(`${label} gera sincronização`, async () => {
    const current = computer();
    const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "SYNCED", snapshot: snapshotFromComputer(current, { includeOffice: true }) }], current);
    Object.assign(current, change(current));
    await queueComputerInventorySync({ db, computadorId: 162, includeOffice: true });
    assert.equal(db.items.length, 2);
    assert.equal(db.items[1].status, "PENDING");
  });
}

test("mudança somente em campo manual não entra no snapshot", () => {
  const before = snapshotFromComputer(computer(), { includeOffice: true });
  const after = snapshotFromComputer(computer({ apelido: "novo nome", fabricante: "outro" }), { includeOffice: true });
  assert.equal(snapshotsEqual(before, after), true);
});

test("computador sem equipamento ou baseline não sincroniza", async () => {
  for (const current of [computer({ equipamentoNumero: null }), computer({ inventoryBaseline: null })]) {
    const db = outboxDb([], current);
    const result = await queueComputerInventorySync({ db, computadorId: 162 });
    assert.equal(result.queued, false);
    assert.equal(db.items.length, 0);
  }
});

test("sync PENDING/PROCESSING equivalente não duplica e acompanha mudança mais recente", async () => {
  const current = computer();
  const first = snapshotFromComputer(current);
  const db = outboxDb([{ id: 1, computerId: 162, baselineId: 9, equipamentoNumero: "77", operation: "UPSERT_INVENTORY", status: "PENDING", snapshot: first }], current);
  current.ramTotal = 32 * 1024 ** 3;
  await queueComputerInventorySync({ db, computadorId: 162 });
  assert.equal(db.items.length, 1);
  assert.equal(db.items[0].snapshot.values.C, "32 GB");
  db.items[0].status = "PROCESSING";
  current.ramTotal = 64 * 1024 ** 3;
  await queueComputerInventorySync({ db, computadorId: 162 });
  assert.equal(db.items.length, 1);
  assert.equal(db.items[0].snapshot.values.C, "64 GB");
});

test("baseline esperado não é alterado pelo estado atual", async () => {
  const expected = { id: 9, equipamentoNumero: "77", processadorEsperado: "old CPU", ramEsperada: 8 };
  const current = computer({ inventoryBaseline: expected });
  const db = outboxDb([], current);
  await queueComputerInventorySync({ db, computadorId: 162 });
  assert.deepEqual(expected, { id: 9, equipamentoNumero: "77", processadorEsperado: "old CPU", ramEsperada: 8 });
});

function workbook() {
  const shared = ["EQUIP. N°", "PROCESSADOR", " RAM", "SISTEMA OPERACIONAL", "marca", "atual", "ARMAZENAMENTO", "KEY WIN", "OFFICE KEY", "OFFICE", "77", "old CPU", "8 GB", "Windows 10", "MANUAL-MARCA", "MANUAL-USUARIO", "240 GB", "WIN-MANUAL", "DV3TM", "2013 H B"];
  const s = (i, ref) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const row = `<row r="2">${s(10, "A2")}${s(11, "B2")}${s(12, "C2")}${s(13, "D2")}${s(14, "E2")}${s(15, "F2")}${s(16, "G2")}${s(17, "H2")}${s(18, "I2")}${s(19, "J2")}</row>`;
  const files = { "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="INVENTARIO" r:id="rId1"/></sheets></workbook>'), "xl/_rels/workbook.xml.rels": strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'), "xl/sharedStrings.xml": strToU8(`<sst>${shared.map((v) => `<si><t>${v}</t></si>`).join("")}</sst>`), "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1">${shared.slice(0, 10).map((_, i) => s(i, String.fromCharCode(65 + i) + "1")).join("")}</row>${row}</sheetData></worksheet>`) };
  return Buffer.from(zipSync(files));
}

test("linha inexistente não altera outra linha e A/E/F/H permanecem iguais", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ti-auto-sync-"));
  const file = path.join(dir, "inventario.xlsx");
  fs.writeFileSync(file, workbook());
  const before = fs.readFileSync(file);
  const beforeXml = strFromU8(unzipSync(new Uint8Array(before))["xl/worksheets/sheet1.xml"]);
  const snap = snapshotFromComputer(computer(), { includeOffice: true });
  assert.throws(() => syncBaselineToExcel({ baseline: { ...baseline(), equipamentoNumero: "99" }, snapshot: snap, filePath: file, backupDir: path.join(dir, "backups") }), /não encontrado/);
  assert.deepEqual(fs.readFileSync(file), before);
  syncBaselineToExcel({ baseline: baseline(), snapshot: snap, filePath: file, backupDir: path.join(dir, "backups") });
  const row = readInventoryRows(file)[0];
  assert.equal(row.fabricanteModeloEsperado, "MANUAL-MARCA");
  assert.equal(row.apelidoEsperado, "MANUAL-USUARIO");
  assert.equal(row.officePartialKeyEsperada, "DV3TM");
  const xml = strFromU8(unzipSync(new Uint8Array(fs.readFileSync(file)))["xl/worksheets/sheet1.xml"]);
  assert.equal(xml.match(/<c r="H2"[^>]*>[\s\S]*?<\/c>/)?.[0], beforeXml.match(/<c r="H2"[^>]*>[\s\S]*?<\/c>/)?.[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});
