const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createCertificateReleaseService } = require("./src/services/certificateRelease.service");

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ti-audit-failure-"));
  const destination = path.join(root, "destination");
  fs.mkdirSync(destination);
  return { root, destination };
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

function removalHelper(io = fs) {
  return {
    run: async ({ operation, destinationRoot, filename, expectedFingerprint }) => {
      const target = path.resolve(destinationRoot, filename);
      let stats;
      try { stats = io.lstatSync(target); } catch (error) {
        if (error.code === "ENOENT") return { ok: true, result: "ABSENT" };
        return { ok: false, result: "ERROR", code: "HELPER_TARGET_UNAVAILABLE" };
      }
      if (!stats.isFile()) return { ok: false, result: "ERROR", code: "HELPER_TARGET_UNSAFE" };
      if (operation === "remove_temp") { io.unlinkSync(target); return { ok: true, result: "REMOVED" }; }
      const fingerprint = hash(io.readFileSync(target));
      if (fingerprint !== expectedFingerprint) return { ok: false, result: "ERROR", code: "FINGERPRINT_MISMATCH" };
      if (operation === "inspect") return { ok: true, result: "PRESENT_VALID" };
      io.unlinkSync(target);
      return { ok: true, result: "REMOVED" };
    },
    stop() {}
  };
}

function transactionalDb(request, audits, failEvents = new Set()) {
  const matches = (where) => {
    if (where.id !== request.id) return false;
    if (where.statusLiberacao && (typeof where.statusLiberacao === "string"
      ? request.statusLiberacao !== where.statusLiberacao
      : !where.statusLiberacao.in.includes(request.statusLiberacao))) return false;
    if (where.releaseAttemptId && request.releaseAttemptId !== where.releaseAttemptId) return false;
    return true;
  };
  const apply = (where, data) => {
    if (!matches(where)) return { count: 0 };
    for (const [key, value] of Object.entries(data)) request[key] = value?.increment ? (request[key] || 0) + value.increment : value;
    return { count: 1 };
  };
  const api = {
    solicitacaoCertificado: {
      findUnique: async () => request,
      findMany: async () => [request],
      updateMany: async ({ where, data }) => apply(where, data),
      update: async ({ data }) => { Object.assign(request, data); return request; }
    },
    certificadoLiberacaoAuditoria: {
      create: async ({ data }) => {
        if (failEvents.has(data.evento)) { failEvents.delete(data.evento); throw Object.assign(new Error("audit unavailable"), { code: "AUDIT_UNAVAILABLE" }); }
        audits.push(data);
      }
    }
  };
  return {
    ...api,
    $transaction: async (operation) => {
      const snapshot = { ...request };
      const auditCount = audits.length;
      try { return await operation(api); } catch (error) {
        Object.keys(request).forEach((key) => delete request[key]);
        Object.assign(request, snapshot);
        audits.length = auditCount;
        throw error;
      }
    }
  };
}

function cleanupRequest(filename, fingerprint) {
  const expired = new Date(2);
  return {
    id: 1,
    estado: "APROVADA",
    statusLiberacao: "LIBERADO",
    nomeArquivoLiberado: filename,
    releaseFingerprint: fingerprint,
    releasedAt: new Date(1),
    expiresAt: expired,
    atualizadoEm: new Date(1),
    tentativasLiberacao: 0,
    releaseAttemptId: null,
    releaseStartedAt: null,
    releaseStage: null,
    certificado: { id: 3 }
  };
}

test("cleanup com auditoria indisponível não perde RELEASE_EXPIRED e tenta novamente", async () => {
  const t = tree();
  const filename = "expired.pfx";
  const content = "EXPIRED-CERTIFICATE";
  const request = cleanupRequest(filename, hash(content));
  const audits = [];
  fs.writeFileSync(path.join(t.destination, filename), content);
  const db = transactionalDb(request, audits, new Set(["RELEASE_EXPIRED"]));
  try {
    const service = createCertificateReleaseService({ db, destinationPath: t.destination, now: () => new Date(100000000), removalHelper: removalHelper() });
    await service.cleanupExpired();
    assert.equal(request.statusLiberacao, "REMOCAO_PENDENTE");
    assert.deepEqual(audits.map((item) => item.evento), ["RELEASE_REMOVAL_FAILED"]);
    assert.equal(fs.existsSync(path.join(t.destination, filename)), false);

    const retry = await service.recoverStaleRemovals();
    assert.equal(retry.recovered, 1);
    assert.equal(request.statusLiberacao, "EXPIRADA");
    assert.deepEqual(audits.map((item) => item.evento), ["RELEASE_REMOVAL_FAILED", "RELEASE_EXPIRED", "RELEASE_FILE_REMOVED"]);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});

test("recovery com auditoria indisponível mantém pendência e repete RELEASE_RECOVERED", async () => {
  const t = tree();
  const request = {
    id: 2,
    estado: "PENDENTE",
    statusLiberacao: "PUBLICANDO",
    releaseAttemptId: crypto.randomUUID(),
    releaseStartedAt: new Date(1),
    releaseStage: "PUBLISHING",
    nomeArquivoLiberado: "recovery.pfx",
    releaseFingerprint: hash("RECOVERY-CERTIFICATE"),
    certificado: { id: 4, extensao: ".pfx" }
  };
  const audits = [];
  fs.writeFileSync(path.join(t.destination, request.nomeArquivoLiberado), "RECOVERY-CERTIFICATE");
  const db = transactionalDb(request, audits, new Set(["RELEASE_RECOVERED"]));
  try {
    const service = createCertificateReleaseService({ db, destinationPath: t.destination, now: () => new Date(100000000), removalHelper: removalHelper() });
    const first = await service.recoverAbandonedAttempts();
    assert.equal(first.recovered, 0);
    assert.equal(request.statusLiberacao, "RECUPERACAO_PENDENTE");
    assert.deepEqual(audits.map((item) => item.evento), ["RELEASE_RECOVERY_PENDING"]);

    const retry = await service.recoverAbandonedAttempts();
    assert.equal(retry.recovered, 1);
    assert.equal(request.statusLiberacao, "NAO_LIBERADO");
    assert.deepEqual(audits.map((item) => item.evento), ["RELEASE_RECOVERY_PENDING", "RELEASE_RECOVERED"]);
  } finally { fs.rmSync(t.root, { recursive: true, force: true }); }
});
