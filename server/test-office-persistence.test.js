const test = require("node:test");
const assert = require("node:assert/strict");
const { persistOfficeInventory } = require("./src/inventory/persistence");

function office(installations) {
  return { collectedAt: "2026-09-02T12:00:00.000Z", installations, warnings: [] };
}

function installation(fingerprint, changes = {}) {
  return {
    source: "OSPP",
    productReleaseId: "Office21ProPlus2021VL_KMS_Client",
    productName: "Office 21",
    edition: "OFFICE_2021",
    version: "16.0.1",
    architecture: "x64",
    updateChannel: null,
    installationTechnology: "MSI_OR_CLICK_TO_RUN",
    activationStatus: "LICENSED",
    rawStatusCode: "---LICENSED---",
    licenseType: "VOLUME_KMS",
    licenseName: "Office 21",
    licenseDescription: "VOLUME_KMSCLIENT channel",
    partialProductKey: "ABCDE",
    fingerprint,
    ...changes
  };
}

function createDb(computerIds = [1, 2], options = {}) {
  const records = [];
  const calls = { transactions: 0, upserts: 0, updateMany: 0 };
  const db = {
    records,
    calls,
    computador: { findUnique: async ({ where }) => computerIds.includes(Number(where.id)) ? { id: Number(where.id) } : null },
    $transaction: async (callback) => {
      calls.transactions += 1;
      const snapshot = records.map((record) => ({ ...record }));
      const tx = {
        computador: { findUnique: async ({ where }) => computerIds.includes(Number(where.id)) ? { id: Number(where.id) } : null },
        officeInstallation: {
          upsert: async ({ where, create, update }) => {
            calls.upserts += 1;
            const key = where.computadorId_fingerprint;
            const found = records.find((record) => record.computadorId === key.computadorId && record.fingerprint === key.fingerprint);
            if (found) Object.assign(found, update);
            else records.push({ id: records.length + 1, ...create });
            return found || records.at(-1);
          },
          updateMany: async ({ where, data }) => {
            calls.updateMany += 1;
            if (options.failOnUpdateMany) throw new Error("synthetic transaction failure");
            let count = 0;
            for (const record of records) {
              const excluded = where.fingerprint && where.fingerprint.notIn;
              if (record.computadorId === where.computadorId && (!excluded || !excluded.includes(record.fingerprint))) {
                Object.assign(record, data);
                count += 1;
              }
            }
            return { count };
          }
        }
      };
      try { return await callback(tx); } catch (error) { records.splice(0, records.length, ...snapshot); throw error; }
    }
  };
  return db;
}

const now = new Date("2026-09-02T12:05:00.000Z");

test("first inventory creates installation", async () => {
  const db = createDb();
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now });
  assert.equal(db.records.length, 1);
  assert.equal(db.records[0].isPresent, true);
});

test("same fingerprint updates without duplicating and preserves firstSeenAt", async () => {
  const db = createDb();
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now });
  const firstSeen = db.records[0].firstSeenAt;
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one", { version: "16.0.2" })]), now: new Date(now.getTime() + 1000) });
  assert.equal(db.records.length, 1);
  assert.equal(db.records[0].firstSeenAt, firstSeen);
  assert.equal(db.records[0].version, "16.0.2");
  assert.equal(db.records[0].lastSeenAt.getTime(), now.getTime() + 1000);
  assert.equal(db.records[0].collectedAt.getTime(), new Date("2026-09-02T12:00:00.000Z").getTime());
});

test("new, removed, and reappearing installations reconcile presence", async () => {
  const db = createDb();
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one"), installation("two")]), now });
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("two")]), now });
  assert.equal(db.records.find((record) => record.fingerprint === "one").isPresent, false);
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now });
  assert.equal(db.records.length, 2);
  assert.equal(db.records.find((record) => record.fingerprint === "one").isPresent, true);
});

test("empty inventory marks previous installations absent", async () => {
  const db = createDb();
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now });
  await persistOfficeInventory({ db, computadorId: 1, office: office([]), now });
  assert.equal(db.records[0].isPresent, false);
});

test("invalid payload and unknown computer do not change records", async () => {
  const db = createDb([1]);
  await assert.rejects(() => persistOfficeInventory({ db, computadorId: 1, office: { collectedAt: 123, installations: [], warnings: [] }, now }), /inválido/);
  await assert.rejects(() => persistOfficeInventory({ db, computadorId: 9, office: office([installation("one")]), now }), /não encontrado/);
  assert.deepEqual(db.records, []);
  assert.equal(db.calls.transactions, 1);
});

test("same fingerprint is scoped per computer and duplicate input is ignored", async () => {
  const db = createDb([1, 2]);
  await persistOfficeInventory({ db, computadorId: 1, office: office([installation("same"), installation("same")]), now });
  await persistOfficeInventory({ db, computadorId: 2, office: office([installation("same")]), now });
  assert.equal(db.records.length, 2);
  assert.deepEqual(db.records.map((record) => record.computadorId), [1, 2]);
});

test("partial key longer than five characters is never persisted", async () => {
  const db = createDb();
  await assert.rejects(() => persistOfficeInventory({ db, computadorId: 1, office: office([installation("one", { partialProductKey: "TOO-LONG" })]), now }), /inválido/);
  assert.equal(db.records.length, 0);
});

test("transaction rolls back all installations on failure", async () => {
  const db = createDb([1], { failOnUpdateMany: true });
  await assert.rejects(() => persistOfficeInventory({ db, computadorId: 1, office: office([installation("one"), installation("two")]), now }), /synthetic/);
  assert.deepEqual(db.records, []);
});

test("multiple licenses are preserved and timestamps use safe server fallback", async () => {
  const db = createDb();
  const stale = office([installation("one"), installation("two")]);
  stale.collectedAt = "2000-01-01T00:00:00.000Z";
  await persistOfficeInventory({ db, computadorId: 1, office: stale, now });
  assert.equal(db.records.length, 2);
  assert.equal(db.records.every((record) => record.collectedAt.getTime() === now.getTime()), true);
});

test("concurrent inventories are serialized per computer", async () => {
  const db = createDb();
  await Promise.all([
    persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now }),
    persistOfficeInventory({ db, computadorId: 1, office: office([installation("one")]), now })
  ]);
  assert.equal(db.records.length, 1);
});
