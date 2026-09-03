const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const computadoresController = require("./src/controllers/computadores.controller");
const computadoresService = require("./src/services/computadores.service");
const { requireHumanSession } = require("./src/auth/middleware");
const { createAuthService, createPasswordHash } = require("./src/auth/service");

const fakeFullOfficeKey = "ABCDE-12345-FGHIJ-KLMNO-TFY23";

function makeComputer(overrides = {}) {
  return {
    id: 162,
    deviceId: "fake-device-162",
    hostname: "fake-office-pc",
    apelido: null,
    equipamentoNumero: null,
    processador: "Intel(R) Core(TM) i5-14500",
    ramTotal: 16 * 1024 ** 3,
    sistema: "win32",
    sistemaRelease: "10.0.26200",
    discosFisicos: [{ id: 1, tamanho: 512105932800, modelo: "Fake NVMe 512GB" }],
    officeInstallations: [
      { id: 1, source: "MSI", productName: "Microsoft Office Home and Business 2013 - pt-br", version: "15.0" },
      { id: 2, source: "OSPP", licenseName: "Office 15, OfficeHomeBusinessR_Grace edition", licenseDescription: "Office 15, RETAIL(Grace) channel", activationStatus: "GRACE", licenseType: "RETAIL", partialProductKey: "DV3TM" }
    ],
    inventoryBaseline: null,
    ...overrides
  };
}

function makeDb({ computer = makeComputer(), equipmentBaselines = [], failCreate = false } = {}) {
  const state = { computer: structuredClone(computer), equipmentBaselines: [...equipmentBaselines], baseline: computer?.inventoryBaseline || null, excelSyncs: [] };
  let transactionTail = Promise.resolve();
  const db = {
    state,
    $transaction(work) {
      const run = transactionTail.then(async () => {
        const staged = { computer: structuredClone(state.computer), equipmentBaselines: [...state.equipmentBaselines], baseline: structuredClone(state.baseline), excelSyncs: [...state.excelSyncs] };
        const tx = {
          computador: {
            findUnique: async () => staged.computer ? structuredClone({ ...staged.computer, inventoryBaseline: staged.baseline }) : null,
            update: async ({ data }) => { staged.computer = { ...staged.computer, ...data }; return structuredClone(staged.computer); }
          },
          computerInventoryBaseline: {
            findUnique: async ({ where }) => where.equipamentoNumero ? staged.equipmentBaselines.find((item) => item.equipamentoNumero === where.equipamentoNumero) || null : staged.baseline,
            create: async ({ data }) => {
              if (failCreate) throw new Error("simulated baseline failure");
              staged.baseline = { id: 1, ...data };
              staged.equipmentBaselines.push(staged.baseline);
              return structuredClone(staged.baseline);
            }
          },
          excelInventorySync: {
            findFirst: async () => staged.excelSyncs[staged.excelSyncs.length - 1] || null,
            create: async ({ data }) => { const item = { id: staged.excelSyncs.length + 1, ...data }; staged.excelSyncs.push(item); return structuredClone(item); }
          }
        };
        const result = await work(tx);
        Object.assign(state, staged);
        return result;
      });
      transactionTail = run.catch(() => undefined);
      return run;
    }
  };
  db.computador = { findUnique: async () => state.computer ? structuredClone({ ...state.computer, inventoryBaseline: state.baseline }) : null };
  db.computerInventoryBaseline = { findUnique: async () => structuredClone(state.baseline) };
  db.excelInventorySync = { findFirst: async () => { const item = state.excelSyncs[state.excelSyncs.length - 1]; return item ? { id: item.id, status: item.status } : null; } };
  return db;
}

function invoke(handler, params, body) {
  return new Promise((resolve) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); } };
    handler({ params, body }, response);
  });
}

function request(server, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request({ port: server.address().port, method, path, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function createHandler(db) {
  return computadoresController.createComputadoresController({ service: computadoresService.createComputadoresService({ db }) }).addInventoryBaseline;
}

test("requires human authentication for Add to Inventory", async () => {
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("senha", { salt: "0123456789abcdef0123456789abcdef" }) });
  const app = express();
  app.use(express.json());
  app.post("/api/computadores/:id/inventory-baseline", requireHumanSession(auth), createHandler(makeDb()));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { assert.equal(await request(server, "POST", "/api/computadores/162/inventory-baseline", { equipamentoNumero: 77, apelido: "Sheila" }), 401); } finally { await new Promise((resolve) => server.close(resolve)); }
});

test("creates a baseline from the server snapshot and keeps only a partial Office key", async () => {
  const db = makeDb();
  const result = await invoke(createHandler(db), { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.excelSync, { id: 1, status: "PENDING" });
  assert.equal(db.state.computer.equipamentoNumero, "77");
  assert.equal(db.state.computer.apelido, "Sheila");
  assert.equal(db.state.baseline.armazenamentoEsperado, "512 GB");
  assert.equal(db.state.baseline.officeEsperado, "Microsoft Office Home and Business 2013 - pt-br");
  assert.equal(db.state.baseline.officePartialKeyEsperada, "DV3TM");
  assert.equal(JSON.stringify(db.state.baseline).includes(fakeFullOfficeKey), false);
  assert.equal(Object.values(db.state.baseline).includes("LICENSED"), false);
});

test("rolls back baseline and identity when Excel enqueue fails", async () => {
  const db = makeDb();
  const service = computadoresService.createComputadoresService({ db, enqueue: async () => { throw new Error("simulated enqueue failure"); } });
  const result = await invoke(computadoresController.createComputadoresController({ service }).addInventoryBaseline, { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" });
  assert.equal(result.status, 500);
  assert.equal(db.state.computer.equipamentoNumero, null);
  assert.equal(db.state.baseline, null);
  assert.equal(db.state.excelSyncs.length, 0);
});

test("exposes the latest Excel sync status without exposing sensitive fields", async () => {
  const db = makeDb();
  const service = computadoresService.createComputadoresService({ db });
  db.state.baseline = { id: 1, computadorId: 162, equipamentoNumero: "77", processadorEsperado: "CPU" };
  db.state.excelSyncs.push({ id: 1, baselineId: 1, status: "FAILED", operation: "UPSERT_INVENTORY" });
  const result = await service.getInventoryComparison(162);
  assert.deepEqual(result.excelSync, { id: 1, status: "FAILED" });
  assert.equal(JSON.stringify(result).includes(fakeFullOfficeKey), false);
});

test("rejects technical fields from the Dashboard request", async () => {
  const db = makeDb();
  const result = await invoke(createHandler(db), { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila", processador: "forged" });
  assert.equal(result.status, 400);
  assert.equal(db.state.computer.equipamentoNumero, null);
  assert.equal(db.state.baseline, null);
});

test("returns semantic validation and conflict errors", async () => {
  assert.equal((await invoke(createHandler(makeDb()), { id: "bad" }, { equipamentoNumero: 77 })).status, 400);
  assert.equal((await invoke(createHandler(makeDb({ computer: null })), { id: "162" }, { equipamentoNumero: 77 })).status, 404);
  assert.equal((await invoke(createHandler(makeDb()), { id: "162" }, { equipamentoNumero: "77x" })).status, 400);
  assert.equal((await invoke(createHandler(makeDb({ equipmentBaselines: [{ equipamentoNumero: "77" }] })), { id: "162" }, { equipamentoNumero: 77 })).status, 409);
  assert.equal((await invoke(createHandler(makeDb({ computer: makeComputer({ inventoryBaseline: { id: 1 } }) })), { id: "162" }, { equipamentoNumero: 77 })).status, 409);
});

test("rejects an incomplete snapshot without changing identity or baseline", async () => {
  const db = makeDb({ computer: makeComputer({ processador: null }) });
  const result = await invoke(createHandler(db), { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" });
  assert.equal(result.status, 409);
  assert.equal(db.state.computer.equipamentoNumero, null);
  assert.equal(db.state.computer.apelido, null);
  assert.equal(db.state.baseline, null);
});

test("rolls back identity when baseline creation fails", async () => {
  const db = makeDb({ failCreate: true });
  const result = await invoke(createHandler(db), { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" });
  assert.equal(result.status, 500);
  assert.equal(db.state.computer.equipamentoNumero, null);
  assert.equal(db.state.baseline, null);
});

test("serializes a double click and creates only one baseline", async () => {
  const db = makeDb();
  const handler = createHandler(db);
  const results = await Promise.all([invoke(handler, { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" }), invoke(handler, { id: "162" }, { equipamentoNumero: 77, apelido: "Sheila" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(db.state.equipmentBaselines.filter((item) => item.equipamentoNumero === "77").length, 1);
});
