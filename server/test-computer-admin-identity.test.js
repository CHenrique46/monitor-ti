const test = require("node:test");
const assert = require("node:assert/strict");
const computadoresService = require("./src/services/computadores.service");
const computadoresController = require("./src/controllers/computadores.controller");
const fs = require("fs");

function computer(overrides = {}) {
  return { id: 161, deviceId: "device-161", hostname: "VAVA67", apelido: null, equipamentoNumero: null, discosFisicos: [], ...overrides };
}

function invoke(handler, params, body) {
  return new Promise((resolve) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, body: value }); } };
    handler({ params, body }, response);
  });
}

test("administrative identity starts null and update trims values", async () => {
  const calls = [];
  const db = { computador: { update: async ({ where, data }) => { calls.push({ where, data }); return computer(data); } } };
  const service = computadoresService.createComputadoresService({ db });
  const result = await service.updateInventoryMetadata(161, { apelido: "  Dani Souto  ", equipamentoNumero: " 47. " });
  assert.equal(result.apelido, "Dani Souto");
  assert.equal(result.equipamentoNumero, "47.");
  assert.deepEqual(calls[0].data, { apelido: "Dani Souto", equipamentoNumero: "47." });
});

test("administrative identity fields can be cleared and invalid input is rejected", async () => {
  const db = { computador: { update: async ({ data }) => computer(data) } };
  const service = computadoresService.createComputadoresService({ db });
  const cleared = await service.updateInventoryMetadata(161, { apelido: "", equipamentoNumero: null });
  assert.equal(cleared.apelido, null);
  assert.equal(cleared.equipamentoNumero, null);
  await assert.rejects(() => service.updateInventoryMetadata(161, { apelido: 47 }), (error) => error.code === "INVALID_METADATA");
  await assert.rejects(() => service.updateInventoryMetadata(161, { unknown: "x" }), (error) => error.code === "INVALID_METADATA");
});

test("responsável aceita o alias usuario e preserva número com zero à esquerda", async () => {
  const calls = [];
  const db = { computador: { update: async ({ data }) => { calls.push(data); return computer({ apelido: data.apelido, equipamentoNumero: data.equipamentoNumero }); } } };
  const service = computadoresService.createComputadoresService({ db });
  const result = await service.updateInventoryMetadata(161, { usuario: "  Sheila  ", equipamentoNumero: "04" });
  assert.equal(result.apelido, "Sheila");
  assert.equal(result.equipamentoNumero, "04");
  assert.deepEqual(calls[0], { apelido: "Sheila", equipamentoNumero: "04" });
});

test("Inventário mantém responsável administrativo separado do usuário técnico após reload", async () => {
  const computer = {
    id: 161,
    hostname: "VAVA67",
    usuario: "windows-user",
    apelido: "Pessoa A",
    equipamentoNumero: "04",
    ip: null,
    officeInstallations: [],
    discosFisicos: []
  };
  const db = { computador: {
    findMany: async () => [computer],
    update: async ({ data }) => Object.assign(computer, data)
  } };
  const service = computadoresService.createComputadoresService({ db });

  assert.equal((await service.listInventory())[0].responsavel, "Pessoa A");
  const updated = await service.updateInventoryMetadata(161, { usuario: "Pessoa B" });
  assert.equal(updated.apelido, "Pessoa B");
  assert.equal(computer.usuario, "windows-user");
  assert.equal((await service.listInventory())[0].responsavel, "Pessoa B");
  assert.equal((await service.listInventory())[0].equipamentoNumero, "04");

  computer.apelido = null;
  assert.equal((await service.listInventory())[0].responsavel, null);
});

test("Agent pode atualizar usuario sem sobrescrever apelido administrativo", async () => {
  const source = fs.readFileSync(require.resolve("./src/ws/agentServer"), "utf8");
  assert.match(source, /usuario: d\.usuario \|\| null/);
  assert.doesNotMatch(source, /apelido: d\.usuario/);

  const computer = {
    id: 161,
    hostname: "VAVA67",
    usuario: "usuario-antigo",
    apelido: "Noemi",
    equipamentoNumero: "04",
    officeInstallations: [],
    discosFisicos: []
  };
  const db = { computador: { update: async ({ data }) => Object.assign(computer, data) } };
  await computadoresService.updateInventoryMetadata(161, { apelido: "Noemi" }, db);
  await db.computador.update({ data: { usuario: "usuario-novo" } });
  assert.equal(computer.usuario, "usuario-novo");
  assert.equal(computer.apelido, "Noemi");
});

test("duplicate equipment is rejected before update with the conflicting computer label", async () => {
  const db = { computador: {
    findFirst: async () => ({ hostname: "CONT-55", apelido: null, usuario: null }),
    update: async () => { throw new Error("must not update"); }
  } };
  const service = computadoresService.createComputadoresService({ db });
  await assert.rejects(() => service.updateInventoryMetadata(161, { equipamentoNumero: "55" }), (error) => error.code === "DUPLICATE_EQUIPMENT" && error.message.includes("CONT-55"));
});

test("duplicate equipment number is mapped to a conflict", async () => {
  const db = { computador: { update: async () => { const error = new Error("unique"); error.code = "P2002"; throw error; } } };
  await assert.rejects(() => computadoresService.updateInventoryMetadata(161, { equipamentoNumero: "47" }, db), (error) => error.code === "DUPLICATE_EQUIPMENT");
});

test("metadata endpoint is exposed by the controller", async () => {
  const service = { updateInventoryMetadata: async (id, body) => ({ id: Number(id), ...body }) };
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.updateInventoryMetadata, { id: "161" }, { apelido: "Dani" });
  assert.equal(result.status, 200);
  assert.equal(result.body.apelido, "Dani");
});

test("Agent register, metrics and inventory flows do not write admin fields", () => {
  const source = fs.readFileSync(require.resolve("./src/ws/agentServer"), "utf8");
  assert.doesNotMatch(source, /apelido\s*:/);
  assert.doesNotMatch(source, /equipamentoNumero\s*:/);
  const persistence = fs.readFileSync(require.resolve("./src/inventory/persistence"), "utf8");
  assert.doesNotMatch(persistence, /apelido\s*:/);
  assert.doesNotMatch(persistence, /equipamentoNumero\s*:/);
});
