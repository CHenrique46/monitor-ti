const crypto = require("crypto");

const RETRY_AUTHORIZATION_ACTIVE_STATES = ["PENDING", "ACQUIRED"];
const RETRY_AUTHORIZATION_TERMINAL_EVENTS = ["RELEASE_FILE_REMOVED", "RELEASE_EXPIRED"];
const DEFAULT_RETRY_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;

function makeError(code, message) { return Object.assign(new Error(message), { code }); }

function sanitizeReason(value) {
  const reason = String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!reason || reason.length > 240) throw makeError("INVALID_RETRY_AUTHORIZATION_REASON", "O motivo da autorização é inválido.");
  return reason;
}

function createCertificateReleaseRetryAuthorizationService({ db, now = () => new Date(), maxRetries = 5, ttlMs = DEFAULT_RETRY_AUTHORIZATION_TTL_MS, audit } = {}) {
  if (!db) throw new Error("Banco de dados obrigatório.");
  if (typeof audit !== "function") throw new Error("Auditoria obrigatória.");

  async function expireRequestAuthorization(tx, request, current) {
    const rows = await tx.certificateReleaseRetryAuthorization.findMany({ where: { solicitacaoId: request.id, status: "PENDING", expiresAt: { lte: current } }, select: { id: true } });
    for (const row of rows) {
      const expired = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED", expiredAt: current, errorCode: "AUTHORIZATION_EXPIRED" } });
      if (expired.count === 1) await audit(request, "RELEASE_RETRY_EXPIRED", "SUCCESS", "AUTHORIZATION_EXPIRED", null, tx, row.id);
    }
    return rows.length;
  }

  async function create(requestId, reason, actor) {
    const sanitizedReason = sanitizeReason(reason);
    const current = now();
    return db.$transaction(async (tx) => {
      const request = await tx.solicitacaoCertificado.findUnique({ where: { id: Number(requestId) }, include: { certificado: true, computador: { select: { id: true, hostname: true, usuario: true } } } });
      if (!request) throw makeError("NOT_FOUND", "Solicitação não encontrada.");
      if (request.estado !== "APROVADA" || request.statusLiberacao !== "REMOCAO_PENDENTE") throw makeError("INVALID_RETRY_AUTHORIZATION_STATE", "A solicitação não está pendente de remoção.");
      if (Number(request.tentativasLiberacao) < maxRetries) throw makeError("RETRY_AUTHORIZATION_NOT_AT_LIMIT", "A solicitação ainda não atingiu o limite de tentativas.");
      if (!request.expiresAt || new Date(request.expiresAt).getTime() > current.getTime()) throw makeError("RETRY_AUTHORIZATION_NOT_EXPIRED", "A liberação ainda não expirou.");
      if (request.releaseAttemptId !== null || request.releaseStartedAt !== null || request.releaseStage !== null) throw makeError("RETRY_AUTHORIZATION_LEASE_ACTIVE", "A solicitação possui uma tentativa ativa.");
      await expireRequestAuthorization(tx, request, current);
      const terminal = await tx.certificadoLiberacaoAuditoria.findFirst({ where: { solicitacaoId: request.id, evento: { in: RETRY_AUTHORIZATION_TERMINAL_EVENTS } }, select: { id: true } });
      if (terminal) throw makeError("RETRY_AUTHORIZATION_TERMINAL", "A solicitação já possui um evento terminal.");
      const active = await tx.certificateReleaseRetryAuthorization.findFirst({ where: { solicitacaoId: request.id, status: { in: RETRY_AUTHORIZATION_ACTIVE_STATES } }, select: { id: true } });
      if (active) throw makeError("RETRY_AUTHORIZATION_ACTIVE", "Já existe uma autorização extraordinária ativa.");
      const authorization = await tx.certificateReleaseRetryAuthorization.create({ data: { id: crypto.randomUUID(), solicitacaoId: request.id, reason: sanitizedReason, status: "PENDING", createdAt: current, expiresAt: new Date(current.getTime() + ttlMs) } });
      await audit(request, "RELEASE_RETRY_AUTHORIZED", "SUCCESS", "AUTHORIZED", actor, tx, authorization.id);
      return authorization;
    });
  }

  async function cancel(id, actor) {
    const current = now();
    return db.$transaction(async (tx) => {
      const authorization = await tx.certificateReleaseRetryAuthorization.findUnique({ where: { id }, include: { solicitacao: { include: { certificado: true } } } });
      if (!authorization) throw makeError("NOT_FOUND", "Autorização não encontrada.");
      const changed = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id, status: "PENDING", expiresAt: { gt: current } }, data: { status: "CANCELLED", cancelledAt: current } });
      if (changed.count !== 1) throw makeError("RETRY_AUTHORIZATION_CONFLICT", "A autorização já foi consumida, expirada ou cancelada.");
      await audit(authorization.solicitacao, "RELEASE_RETRY_CANCELLED", "SUCCESS", "CANCELLED", actor, tx, id);
      return { ...authorization, status: "CANCELLED", cancelledAt: current };
    });
  }

  async function expire() {
    const current = now();
    return db.$transaction(async (tx) => {
      const rows = await tx.certificateReleaseRetryAuthorization.findMany({ where: { status: "PENDING", expiresAt: { lte: current } }, include: { solicitacao: { include: { certificado: true } } }, take: 100 });
      let expired = 0;
      for (const row of rows) {
        const changed = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "EXPIRED", expiredAt: current, errorCode: "AUTHORIZATION_EXPIRED" } });
        if (changed.count === 1) { expired += 1; await audit(row.solicitacao, "RELEASE_RETRY_EXPIRED", "SUCCESS", "AUTHORIZATION_EXPIRED", null, tx, row.id); }
      }
      return { expired };
    });
  }

  return { create, cancel, expire, sanitizeReason, activeStates: RETRY_AUTHORIZATION_ACTIVE_STATES };
}

module.exports = { createCertificateReleaseRetryAuthorizationService, DEFAULT_RETRY_AUTHORIZATION_TTL_MS, RETRY_AUTHORIZATION_ACTIVE_STATES, RETRY_AUTHORIZATION_TERMINAL_EVENTS, sanitizeReason };
