const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const computadoresService = require("./src/services/computadores.service");
const computadoresController = require("./src/controllers/computadores.controller");
const { requireHumanSession } = require("./src/auth/middleware");
const { createAuthService, createPasswordHash } = require("./src/auth/service");

function office(overrides = {}) {
  return {
    id: 10,
    source: "click-to-run",
    productReleaseId: "M365",
    productName: "Microsoft 365 Apps",
    edition: "Enterprise",
    version: "16.0.1",
    architecture: "x64",
    updateChannel: "Current",
    installationTechnology: "ClickToRun",
    activationStatus: "licensed",
    rawStatusCode: "0xC004C003",
    licenseType: "Retail",
    licenseName: "Microsoft 365",
    licenseDescription: "Subscription",
    partialProductKey: "12345",
    fingerprint: "must-not-leak",
    isPresent: true,
    firstSeenAt: new Date("2026-09-01T10:00:00.000Z"),
    lastSeenAt: new Date("2026-09-02T10:00:00.000Z"),
    collectedAt: new Date("2026-09-02T10:00:00.000Z"),
    ...overrides
  };
}

function makeService(records = []) {
  const calls = [];
  const db = {
    computador: {
      findUnique: async (args) => {
        calls.push(args);
        if (Number(args.where.id) === 999) return null;
        return {
          id: 1,
          deviceId: "device-1",
          hostname: "PC-1",
          discosFisicos: [],
          officeInstallations: records.filter((item) => args.include.officeInstallations.where.isPresent ? item.isPresent : true)
        };
      }
    }
  };
  return { service: computadoresService.createComputadoresService({ db }), calls };
}

function invoke(handler, params = {}) {
  return new Promise((resolve) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); }
    };
    handler({ params }, response);
  });
}

function request(server, method, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method, path, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("usuário não autenticado não acessa o inventário Office", async () => {
  const app = require("./src/app");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/computadores/1")).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("computador inexistente retorna 404", async () => {
  const { service } = makeService();
  const controller = computadoresController.createComputadoresController({ service });
  assert.equal((await invoke(controller.getById, { id: 999 })).status, 404);
});

test("computador sem registros retorna inventário desconhecido e vazio", async () => {
  const { service } = makeService();
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.getById, { id: 1 });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.office, { available: null, inventoryStatus: "unknown", installations: [] });
});

test("uma instalação atual retorna somente os campos permitidos", async () => {
  const { service } = makeService([office({ partialProductKey: "ABCDE99999" })]);
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.getById, { id: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.office.available, true);
  assert.equal(result.body.office.installations.length, 1);
  assert.equal(result.body.office.installations[0].partialProductKey, "99999");
  assert.equal(Object.hasOwn(result.body.office.installations[0], "fingerprint"), false);
  assert.equal(Object.hasOwn(result.body.office.installations[0], "computadorId"), false);
  assert.equal(Object.hasOwn(result.body.office.installations[0], "isPresent"), false);
});

test("múltiplas instalações atuais são preservadas", async () => {
  const { service } = makeService([office({ id: 10 }), office({ id: 11, productName: "Office LTSC" })]);
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.getById, { id: 1 });
  assert.deepEqual(result.body.office.installations.map((item) => item.id), [10, 11]);
});

test("instalações ausentes não aparecem e a query filtra isPresent", async () => {
  const { service, calls } = makeService([office({ id: 10 }), office({ id: 11, isPresent: false })]);
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.getById, { id: 1 });
  assert.deepEqual(result.body.office.installations.map((item) => item.id), [10]);
  assert.deepEqual(calls[0].include.officeInstallations.where, { isPresent: true });
});

test("endpoint de computadores mantém os campos existentes e não expõe dados sensíveis", async () => {
  const { service } = makeService([office()]);
  const controller = computadoresController.createComputadoresController({ service });
  const result = await invoke(controller.getById, { id: 1 });
  assert.equal(result.body.hostname, "PC-1");
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("must-not-leak"), false);
  assert.equal(serialized.includes("ospp"), false);
  assert.equal(serialized.includes("stdout"), false);
  assert.equal(serialized.includes("12345"), true);
});

test("rota protegida continua compatível com sessão humana", async () => {
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("senha-local", { salt: "0123456789abcdef0123456789abcdef" }) });
  const { service } = makeService([office()]);
  const controller = computadoresController.createComputadoresController({ service });
  const app = express();
  app.get("/api/computadores/:id", requireHumanSession(auth), controller.getById);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/computadores/1")).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
