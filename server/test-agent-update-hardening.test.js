const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");

const controller = require("./src/controllers/agentUpdate.controller");
const tracking = require("./src/services/agentUpdates.service");
const agentServer = require("./src/ws/agentServer");
const { persistReleaseRecord } = require("./src/services/agentReleaseRegistration.service");

function response() {
  return {
    code: 200,
    body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function request(req, res) {
  return controller.trigger(req, res, req.deps);
}

function baseDb(computer) {
  let nextId = 1;
  const rows = [];
  return {
    rows,
    computador: { findUnique: async () => computer },
    agentUpdate: {
      create: async ({ data }) => {
        if (rows.some((row) => row.computadorId === data.computadorId && tracking.isActive(row.status))) {
          const error = new Error("unique active update"); error.code = "P2002"; throw error;
        }
        const row = { id: nextId++, ...data, iniciadoEm: new Date(), atualizadoEm: new Date(), finalizadoEm: null };
        rows.push(row); return row;
      },
      update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
      findFirst: async ({ where, orderBy }) => rows.filter((row) => (!where.computadorId || row.computadorId === where.computadorId) && (!where.deviceId || row.deviceId === where.deviceId) && (!where.status || where.status.in.includes(row.status))).sort((a, b) => orderBy.iniciadoEm === "desc" ? b.iniciadoEm - a.iniciadoEm : 0)[0] || null,
      updateMany: async ({ where, data }) => { let count = 0; for (const row of rows) if (where.status.in.includes(row.status) && row.atualizadoEm < where.atualizadoEm.lt) { Object.assign(row, data); count += 1; } return { count }; }
    }
  };
}

test("semver bloqueia igualdade e downgrade e permite upgrade", async () => {
  const c = { id: 162, deviceId: "dev-162", hostname: "PC-162", status: "online", agentVersion: "1.1.19" };
  const db = baseDb(c);
  const release = { id: 10, version: "1.1.22", packageName: "pkg.zip", packageSha256: "sha", packageSize: 10 };
  const sent = [];
  const deps = { prisma: db, releasesService: { getActiveRelease: async () => release, hasArtifact: () => true }, agentServer: { sendToAgent: (device, command) => { sent.push({ device, command }); return true; } } };
  const ok = response(); await request({ params: { id: "162" }, humanUser: { username: "admin" }, deps }, ok);
  assert.equal(ok.code, 202); assert.equal(sent.length, 1);

  for (const [current, target] of [["1.1.22", "1.1.22"], ["1.1.22", "1.1.19"], ["1.1.9", "1.1.10"]]) {
    const db2 = baseDb({ ...c, agentVersion: current });
    const release2 = { ...release, version: target };
    const out = response();
    await request({ params: { id: "162" }, humanUser: { username: "admin" }, deps: { ...deps, prisma: db2, releasesService: { getActiveRelease: async () => release2, hasArtifact: () => true } } }, out);
    assert.equal(out.code, current === "1.1.9" ? 202 : 409);
  }
  assert.equal(tracking.toPublic(db.rows[0]).persistentStatus, "PENDING");
});

test("lock por computador é atômico no armazenamento", async () => {
  const db = baseDb({ id: 1, deviceId: "d1", hostname: "PC", status: "online", agentVersion: "1.1.19" });
  const results = await Promise.all([tracking.createPending(db, { computadorId: 1, deviceId: "d1", hostname: "PC", versaoAnterior: "1.1.19", versaoDestino: "1.1.22", iniciadoPor: "admin" }), tracking.createPending(db, { computadorId: 1, deviceId: "d1", hostname: "PC", versaoAnterior: "1.1.19", versaoDestino: "1.1.22", iniciadoPor: "admin" })]);
  assert.equal(results.filter((item) => item.ok).length, 1);
  assert.equal(results.filter((item) => item.conflict).length, 1);
});

test("status persiste e atualização órfã expira", async () => {
  const db = baseDb({ id: 1 });
  const created = await tracking.createPending(db, { computadorId: 1, deviceId: "d1", hostname: "PC", versaoAnterior: "1.1.19", versaoDestino: "1.1.22", iniciadoPor: "admin" });
  await tracking.applyAgentStatus(db, "d1", { status: "update_installing", version: "1.1.22" });
  const reconstructed = await tracking.latest(db, 1);
  assert.equal(reconstructed.status, "INSTALLING");
  reconstructed.atualizadoEm = new Date(Date.now() - tracking.DEFAULT_TIMEOUT_MS - 1);
  const expired = await tracking.recoverExpired(db);
  assert.equal(expired.count, 1);
  assert.equal((await tracking.latest(db, 1)).status, "FAILED");
  assert.equal(created.ok, true);
});

test("status de dois Agents fica vinculado à conexão", async () => {
  const server = http.createServer();
  const db = {
    computador: {
      upsert: async ({ create }) => ({ id: create.deviceId === "A" ? 1 : 2, ...create }),
      updateMany: async () => ({ count: 0 })
    },
    agentUpdate: { findFirst: async () => null },
    $transaction: async (fn) => fn({ discoFisico: { deleteMany: async () => {}, createMany: async () => {} } })
  };
  agentServer.resetUpdateStatesForTests();
  const wss = agentServer.setupWebSocket(server, { prisma: db, avisosService: { obterPendentesDoDispositivo: async () => [] } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const a = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  const b = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await Promise.all([new Promise((resolve, reject) => { a.once("open", resolve); a.once("error", reject); }), new Promise((resolve, reject) => { b.once("open", resolve); b.once("error", reject); })]);
    a.send(JSON.stringify({ type: "register", data: { deviceId: "A", hostname: "A", capabilities: [] } }));
    b.send(JSON.stringify({ type: "register", data: { deviceId: "B", hostname: "B", capabilities: [] } }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    a.send(JSON.stringify({ type: "update_status", deviceId: "B", status: "update_failed", error: "spoof" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(agentServer.getUpdateState("B"), null);
    a.send(JSON.stringify({ type: "update_status", status: "update_failed", error: "sem device" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(agentServer.getUpdateState("A").status, "update_failed");
  } finally {
    a.close(); b.close(); await new Promise((resolve) => wss.close(resolve)); await new Promise((resolve) => server.close(resolve));
  }
});

test("release sem artefato não é disparada", async () => {
  const db = baseDb({ id: 1, deviceId: "d1", hostname: "PC", status: "online", agentVersion: "1.1.19" });
  let sent = 0;
  const out = response();
  await request({ params: { id: "1" }, humanUser: { username: "admin" }, deps: { prisma: db, releasesService: { getActiveRelease: async () => ({ id: 1, version: "1.1.22" }), hasArtifact: () => false }, agentServer: { sendToAgent: () => { sent += 1; return true; } } } }, out);
  assert.equal(out.code, 409); assert.equal(sent, 0); assert.equal(db.rows.length, 0);
});

test("registro de release usa transação e mantém defaults", async () => {
  let activeUpdates = 0;
  let upsertUpdate;
  const db = { $transaction: async (fn) => fn({ agentRelease: { upsert: async ({ create, update }) => { upsertUpdate = update; return { id: 2, ...create }; }, updateMany: async () => { activeUpdates += 1; } } }) };
  await persistReleaseRecord(db, { version: "1.1.22", activate: false, create: { version: "1.1.22", active: false }, update: { active: false } });
  assert.equal(activeUpdates, 0);
  assert.equal(upsertUpdate.active, false);
  let activated = null;
  const activatingDb = { $transaction: async (fn) => fn({ agentRelease: { upsert: async ({ create }) => { activated = create.active; return { id: 2, ...create }; }, updateMany: async () => { activeUpdates += 1; } } }) };
  await persistReleaseRecord(activatingDb, { version: "1.1.22", activate: true, create: { version: "1.1.22", active: true }, update: { active: true } });
  assert.equal(activated, true);
  assert.equal(activeUpdates, 1);
  await assert.rejects(() => persistReleaseRecord({ $transaction: async (fn) => fn({ agentRelease: { upsert: async () => { throw new Error("validation"); }, updateMany: async () => { activeUpdates += 1; } } }) }, { version: "1.1.23", activate: true, create: {}, update: {} }));
  assert.equal(activeUpdates, 1);
});
