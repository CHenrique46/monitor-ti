const test = require("node:test");
const assert = require("node:assert/strict");
const { createCertificateCatalogSyncService } = require("./src/services/certificateCatalogSync.service");
const { createCertificateCatalogSyncScheduler } = require("./src/services/certificateCatalogSyncScheduler.service");
const { getCertificadosSyncEnabled, getCertificadosSyncIntervalMinutes } = require("./src/config");

function database(initial = []) {
  const rows = [...initial];
  let nextId = rows.length + 1;
  return {
    rows,
    sincronizacaoCatalogoCertificado: {
      create: async ({ data }) => { const row = { id: nextId++, encontrados: 0, criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: 0, ...data }; rows.push(row); return row; },
      update: async ({ where, data }) => { const row = rows.find((item) => item.id === where.id); Object.assign(row, data); return row; },
      findMany: async ({ orderBy, skip = 0, take } = {}) => { const ordered = [...rows].sort((a, b) => new Date(b.iniciadaEm) - new Date(a.iniciadaEm) || b.id - a.id); return ordered.slice(skip, take ? skip + take : undefined); },
      deleteMany: async ({ where }) => { const ids = new Set(where.id.in); let count = 0; for (let i = rows.length - 1; i >= 0; i -= 1) if (ids.has(rows[i].id)) { rows.splice(i, 1); count += 1; } return { count }; }
    }
  };
}

test("execução manual persiste resumo agregado e não expõe dados internos", async () => {
  const db = database();
  const service = createCertificateCatalogSyncService({ db, clock: (() => { let n = 0; return () => new Date(1000 + n++ * 1000); })(), sync: async () => ({ encontrados: 852, criados: 2, atualizados: 850, inativados: 0, ignorados: 3, erros: 0 }), log: () => {} });
  const result = await service.runManual("admin");
  assert.equal(result.status, "SUCESSO");
  assert.equal(result.encontrados, 852);
  assert.equal(db.rows[0].status, "SUCESSO");
  assert.equal(db.rows[0].executadoPor, "admin");
  assert.equal(JSON.stringify(result).includes("origemChave"), false);
});

test("falha segura registra ERRO e libera o lock", async () => {
  const db = database();
  const service = createCertificateCatalogSyncService({ db, sync: async () => { throw Object.assign(new Error("private path"), { code: "CERTIFICATE_ROOT_UNAVAILABLE" }); }, log: () => {} });
  await assert.rejects(() => service.runManual("admin"), { code: "CERTIFICATE_SYNC_FAILED" });
  assert.equal(db.rows[0].status, "ERRO");
  assert.equal(db.rows[0].mensagemSegura.includes("path"), false);
  assert.equal(service.isRunning(), false);
});

test("lock compartilhado impede manual concorrente e scheduler registra ignorada", async () => {
  const db = database();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = createCertificateCatalogSyncService({ db, sync: async () => gate, log: () => {} });
  const first = service.runManual("admin");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.runManual("admin"), { code: "CERTIFICATE_SYNC_IN_PROGRESS" });
  const skipped = await service.runAutomatic();
  assert.equal(skipped.status, "IGNORADA_EM_ANDAMENTO");
  release({ encontrados: 1, criados: 1, atualizados: 0, inativados: 0, ignorados: 0, erros: 0 });
  await first;
  assert.equal(service.isRunning(), false);
});

test("retenção remove somente o excedente do histórico", async () => {
  const initial = Array.from({ length: 101 }, (_, id) => ({ id: id + 1, iniciadaEm: new Date(id), status: "SUCESSO", origemCategoria: "CLIENTE" }));
  const db = database(initial);
  const service = createCertificateCatalogSyncService({ db, sync: async () => ({ encontrados: 0, criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: 0 }), log: () => {} });
  await service.runManual("admin");
  assert.equal(db.rows.length, 100);
});

test("scheduler fica parado por padrão e só executa após atraso quando habilitado", async () => {
  let calls = 0;
  const service = { runAutomatic: async () => { calls += 1; } };
  const disabled = createCertificateCatalogSyncScheduler({ service, enabled: false, initialDelayMs: 1, log: () => {} });
  assert.equal(disabled.start(), false);
  assert.equal(disabled.isStarted(), false);
  const enabled = createCertificateCatalogSyncScheduler({ service, enabled: true, intervalMinutes: 5, initialDelayMs: 5, log: () => {} });
  assert.equal(enabled.start(), true);
  assert.equal(calls, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  enabled.stop();
  assert.equal(calls, 1);
});

test("configuração do scheduler usa default seguro e limita intervalo", () => {
  const oldEnabled = process.env.CERTIFICADOS_SYNC_ENABLED;
  const oldInterval = process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES;
  try {
    delete process.env.CERTIFICADOS_SYNC_ENABLED;
    delete process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES;
    assert.equal(getCertificadosSyncEnabled(), false);
    assert.equal(getCertificadosSyncIntervalMinutes(), 30);
    process.env.CERTIFICADOS_SYNC_ENABLED = "true";
    process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES = "2";
    assert.equal(getCertificadosSyncEnabled(), true);
    assert.equal(getCertificadosSyncIntervalMinutes(), 30);
    process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES = "60";
    assert.equal(getCertificadosSyncIntervalMinutes(), 60);
  } finally {
    if (oldEnabled === undefined) delete process.env.CERTIFICADOS_SYNC_ENABLED; else process.env.CERTIFICADOS_SYNC_ENABLED = oldEnabled;
    if (oldInterval === undefined) delete process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES; else process.env.CERTIFICADOS_SYNC_INTERVAL_MINUTES = oldInterval;
  }
});
