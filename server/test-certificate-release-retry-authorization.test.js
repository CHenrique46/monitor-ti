const test = require("node:test");
const assert = require("node:assert/strict");
const { createCertificateReleaseRetryAuthorizationService } = require("./src/services/certificateReleaseRetryAuthorization.service");
const { createCertificateReleaseService } = require("./src/services/certificateRelease.service");

function request(overrides = {}) {
  return {
    id: 18,
    certificadoId: 3,
    estado: "APROVADA",
    statusLiberacao: "REMOCAO_PENDENTE",
    tentativasLiberacao: 5,
    expiresAt: new Date("2026-09-28T13:00:00.000Z"),
    atualizadoEm: new Date("2026-09-28T12:00:00.000Z"),
    releaseAttemptId: null,
    releaseStartedAt: null,
    releaseStage: null,
    nomeArquivoLiberado: "safe.pfx",
    releaseFingerprint: "fingerprint",
    certificado: { id: 3 },
    computador: { id: 9, hostname: "host-test", usuario: "user-test" },
    ...overrides
  };
}

function authorizationDb(currentRequest, active = null) {
  const audits = [];
  const authorization = {
    id: "4a3f5c11-48ee-4fb2-9c98-8c6c6d8eb2aa",
    solicitacaoId: currentRequest.id,
    status: "PENDING",
    reason: "Falha operacional confirmada",
    createdAt: new Date("2026-09-28T14:00:00.000Z"),
    expiresAt: new Date("2026-09-28T14:30:00.000Z")
  };
  const db = {
    $transaction: async (operation) => operation(db),
    solicitacaoCertificado: {
      findUnique: async () => ({ ...currentRequest }),
    },
    certificadoLiberacaoAuditoria: {
      findFirst: async () => null,
      create: async ({ data }) => audits.push(data)
    },
    certificateReleaseRetryAuthorization: {
      findMany: async () => active ? [active] : [],
      findFirst: async () => active,
      findUnique: async () => active,
      create: async ({ data }) => ({ ...authorization, ...data }),
      updateMany: async ({ where, data }) => {
        if (!active || active.id !== where.id || active.status !== where.status || (where.expiresAt?.lte && active.expiresAt.getTime() > where.expiresAt.lte.getTime())) return { count: 0 };
        Object.assign(active, data);
        return { count: 1 };
      }
    }
  };
  return { db, audits, authorization };
}

test("autoriza uma tentativa extraordinária sem tocar contador ou atualizadoEm", async () => {
  const current = new Date("2026-09-28T14:05:00.000Z");
  const row = request();
  const { db, audits } = authorizationDb(row);
  const service = createCertificateReleaseRetryAuthorizationService({ db, now: () => current, audit: async (req, event, result, code, actor, tx, authorizationId) => audits.push({ req, event, result, code, authorizationId }) });
  const before = { attempts: row.tentativasLiberacao, updated: row.atualizadoEm };
  const created = await service.create(18, "Falha operacional confirmada", "admin-test");
  assert.equal(created.status, "PENDING");
  assert.equal(row.tentativasLiberacao, before.attempts);
  assert.equal(row.atualizadoEm, before.updated);
  assert.equal(audits[0].event, "RELEASE_RETRY_AUTHORIZED");
  assert.equal(audits[0].authorizationId, created.id);
});

test("não permite autorização ativa duplicada e expira/cancela por CAS", async () => {
  const current = new Date("2026-09-28T14:05:00.000Z");
  const row = request();
  const active = { id: "auth-active", status: "PENDING", expiresAt: new Date("2026-09-28T15:00:00.000Z"), solicitacao: row };
  const { db, audits } = authorizationDb(row, active);
  const service = createCertificateReleaseRetryAuthorizationService({ db, now: () => current, audit: async (...args) => audits.push(args) });
  await assert.rejects(() => service.create(18, "segunda tentativa", "admin"), { code: "RETRY_AUTHORIZATION_ACTIVE" });
  const cancelDb = { $transaction: async (operation) => operation(cancelDb), certificateReleaseRetryAuthorization: { findUnique: async () => ({ ...active, solicitacao: row }), updateMany: async () => { active.status = "CANCELLED"; return { count: 1 }; } } };
  const cancelService = createCertificateReleaseRetryAuthorizationService({ db: cancelDb, now: () => current, audit: async (...args) => audits.push(args) });
  await cancelService.cancel("auth-active", "admin");
  assert.equal(active.status, "CANCELLED");
  assert.equal(audits.at(-1)[1], "RELEASE_RETRY_CANCELLED");
});

test("recovery adquire autorização no mesmo CAS e preserva cinco falhas", async () => {
  const current = new Date("2026-09-28T15:00:00.000Z");
  const row = request();
  const auth = { id: "auth-once", solicitacaoId: row.id, status: "PENDING", expiresAt: new Date("2026-09-28T15:30:00.000Z") };
  const audits = [];
  const db = {
    $transaction: async (operation) => operation(db),
    solicitacaoCertificado: {
      findMany: async () => [{ ...row, retryAuthorizations: [auth] }],
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; }
    },
    certificateReleaseRetryAuthorization: {
      updateMany: async ({ where, data }) => {
        if (auth.id !== where.id || auth.status !== where.status || (where.attemptId && auth.attemptId !== where.attemptId)) return { count: 0 };
        Object.assign(auth, data);
        return { count: 1 };
      }
    },
    certificadoLiberacaoAuditoria: { create: async ({ data }) => audits.push(data) }
  };
  const helper = { run: async ({ operation }) => ({ ok: true, result: operation === "inspect" ? "ABSENT" : "ABSENT" }), stop: async () => {} };
  const service = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: helper });
  const result = await service.recoverStaleRemovals();
  assert.equal(result.extraordinary, 1);
  assert.equal(result.recovered, 1);
  assert.equal(row.tentativasLiberacao, 5);
  assert.equal(row.statusLiberacao, "EXPIRADA");
  assert.equal(auth.status, "COMPLETED");
  assert.ok(audits.some((entry) => entry.evento === "RELEASE_FILE_REMOVED" && entry.retryAuthorizationId === auth.id));
});

test("arquivo ausente conclui como ALREADY_ABSENT sem nova remoção e preserva tentativa", async () => {
  const current = new Date("2026-09-28T15:00:00.000Z");
  const row = request({ atualizadoEm: new Date("2026-09-28T12:00:00.000Z") });
  const before = { attempts: row.tentativasLiberacao, updated: row.atualizadoEm };
  const auth = { id: "auth-absent", solicitacaoId: row.id, status: "PENDING", expiresAt: new Date("2026-09-28T15:30:00.000Z") };
  const audits = [];
  const calls = [];
  const db = {
    $transaction: async (operation) => operation(db),
    solicitacaoCertificado: {
      findMany: async () => [{ ...row, retryAuthorizations: [auth] }],
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; }
    },
    certificateReleaseRetryAuthorization: {
      updateMany: async ({ where, data }) => {
        if (auth.id !== where.id || auth.status !== where.status || (where.attemptId && auth.attemptId !== where.attemptId)) return { count: 0 };
        Object.assign(auth, data);
        return { count: 1 };
      }
    },
    certificadoLiberacaoAuditoria: { create: async ({ data }) => audits.push(data) }
  };
  const helper = {
    run: async ({ operation }) => { calls.push(operation); return { ok: true, result: "ABSENT" }; },
    stop: async () => {}
  };
  const service = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: helper });
  const result = await service.recoverStaleRemovals();
  assert.equal(result.recovered, 1);
  assert.deepEqual(calls, ["inspect"]);
  assert.equal(row.statusLiberacao, "EXPIRADA");
  assert.equal(auth.status, "COMPLETED");
  assert.equal(row.tentativasLiberacao, before.attempts);
  assert.equal(row.atualizadoEm, before.updated);
  assert.ok(audits.some((entry) => entry.evento === "RELEASE_FILE_REMOVED" && entry.codigo === "ALREADY_ABSENT"));
  assert.ok(audits.some((entry) => entry.evento === "RELEASE_RETRY_COMPLETED" && entry.codigo === "ALREADY_ABSENT"));
});

test("candidato normal continua sujeito ao backoff e não libera outro registro", async () => {
  const current = new Date("2026-09-28T15:00:00.000Z");
  const row = request({ tentativasLiberacao: 4, atualizadoEm: new Date("2026-09-28T14:50:00.000Z") });
  let leased = false;
  const db = { solicitacaoCertificado: { findMany: async () => [{ ...row, retryAuthorizations: [] }], updateMany: async () => { leased = true; return { count: 0 }; } } };
  const service = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: { run: async () => ({ ok: true, result: "ABSENT" }) } });
  const result = await service.recoverStaleRemovals();
  assert.equal(result.backoffSkipped, 1);
  assert.equal(leased, false);
});

test("dois schedulers disputando a mesma autorização deixam somente um lease", async () => {
  const current = new Date("2026-09-28T15:00:00.000Z");
  const row = request();
  const auth = { id: "auth-race", solicitacaoId: row.id, status: "PENDING", expiresAt: new Date("2026-09-28T15:30:00.000Z") };
  const audits = [];
  const db = {
    $transaction: async (operation) => operation(db),
    solicitacaoCertificado: {
      findMany: async () => [{ ...row, releaseAttemptId: row.releaseAttemptId, retryAuthorizations: [{ ...auth }] }],
      updateMany: async ({ where, data }) => {
        if ((where.tentativasLiberacao?.gte !== undefined && !where.releaseAttemptId && (where.tentativasLiberacao.gte !== 5 || row.releaseAttemptId !== null)) || (where.releaseAttemptId && where.releaseAttemptId !== row.releaseAttemptId)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }
    },
    certificateReleaseRetryAuthorization: {
      updateMany: async ({ where, data }) => {
        if (auth.id !== where.id || auth.status !== where.status) return { count: 0 };
        Object.assign(auth, data);
        return { count: 1 };
      }
    },
    certificadoLiberacaoAuditoria: { create: async ({ data }) => audits.push(data) }
  };
  const helper = { run: async () => ({ ok: true, result: "ABSENT" }), stop: async () => {} };
  const first = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: helper });
  const second = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: helper });
  const results = await Promise.all([first.recoverStaleRemovals(), second.recoverStaleRemovals()]);
  assert.equal(results.filter((item) => item.recovered === 1).length, 1);
  assert.equal(auth.status, "COMPLETED");
  assert.equal(row.tentativasLiberacao, 5);
});

test("falha segura marca autorização como FAILED sem auditoria terminal ou nova tentativa", async () => {
  const current = new Date("2026-09-28T15:00:00.000Z");
  const row = request();
  const auth = { id: "auth-fail", solicitacaoId: row.id, status: "PENDING", expiresAt: new Date("2026-09-28T15:30:00.000Z") };
  const audits = [];
  const db = {
    $transaction: async (operation) => operation(db),
    solicitacaoCertificado: {
      findMany: async () => [{ ...row, retryAuthorizations: [auth] }],
      updateMany: async ({ data }) => { Object.assign(row, data); return { count: 1 }; }
    },
    certificateReleaseRetryAuthorization: {
      updateMany: async ({ where, data }) => { if (where.status !== auth.status) return { count: 0 }; Object.assign(auth, data); return { count: 1 }; }
    },
    certificadoLiberacaoAuditoria: { create: async ({ data }) => audits.push(data) }
  };
  const helper = { run: async () => ({ ok: false, code: "SMB_CONTEXT_INVALID" }), stop: async () => {} };
  const service = createCertificateReleaseService({ db, now: () => current, destinationPath: "C:\\cleanroom\\destination", removalHelper: helper });
  const result = await service.recoverStaleRemovals();
  assert.equal(result.failed, 1);
  assert.equal(row.statusLiberacao, "REMOCAO_PENDENTE");
  assert.equal(row.tentativasLiberacao, 5);
  assert.equal(auth.status, "FAILED");
  assert.equal(audits.some((entry) => entry.evento === "RELEASE_FILE_REMOVED"), false);
});
