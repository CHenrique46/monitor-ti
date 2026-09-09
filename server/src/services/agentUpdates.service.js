const ACTIVE_STATUSES = Object.freeze([
  "PENDING",
  "DOWNLOADING",
  "VALIDATING",
  "INSTALLING",
  "RESTARTING"
]);

const TERMINAL_STATUSES = Object.freeze(["SUCCESS", "FAILED", "ROLLBACK"]);
const STATUS_MAP = Object.freeze({
  update_pending: "PENDING",
  update_downloading: "DOWNLOADING",
  update_validating: "VALIDATING",
  update_installing: "INSTALLING",
  update_restarting: "RESTARTING",
  update_success: "SUCCESS",
  update_failed: "FAILED"
});

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function timeoutMs() {
  const value = Number(process.env.AGENT_UPDATE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

function isActive(status) {
  return ACTIVE_STATUSES.includes(status);
}

function isUniqueViolation(error) {
  return error && (error.code === "P2002" || /unique/i.test(String(error.message || "")));
}

async function createPending(db, data) {
  try {
    return { ok: true, update: await db.agentUpdate.create({
      data: {
        computadorId: data.computadorId,
        deviceId: data.deviceId,
        hostname: data.hostname || "",
        versaoAnterior: data.versaoAnterior || null,
        versaoDestino: data.versaoDestino,
        iniciadoPor: data.iniciadoPor || "unknown",
        releaseId: data.releaseId || null,
        status: "PENDING"
      }
    }) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, conflict: true };
    throw error;
  }
}

async function findActive(db, deviceId) {
  return db.agentUpdate.findFirst({
    where: { deviceId, status: { in: ACTIVE_STATUSES } },
    orderBy: { iniciadoEm: "desc" }
  });
}

async function applyAgentStatus(db, deviceId, message) {
  const update = await findActive(db, deviceId);
  if (!update) return null;
  const status = STATUS_MAP[message.status];
  if (!status) return null;
  const final = TERMINAL_STATUSES.includes(status) || (status === "FAILED" && message.rolledBack);
  const persistedStatus = status === "FAILED" && message.rolledBack ? "ROLLBACK" : status;
  return db.agentUpdate.update({
    where: { id: update.id },
    data: {
      status: persistedStatus,
      erro: message.error || message.message || null,
      ...(final ? { finalizadoEm: new Date() } : {})
    }
  });
}

async function markSuccessOnRegister(db, deviceId, agentVersion) {
  const update = await findActive(db, deviceId);
  if (!update || update.versaoDestino !== agentVersion) return null;
  return db.agentUpdate.update({
    where: { id: update.id },
    data: { status: "SUCCESS", erro: null, finalizadoEm: new Date() }
  });
}

async function recoverExpired(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - timeoutMs());
  return db.agentUpdate.updateMany({
    where: { status: { in: ACTIVE_STATUSES }, atualizadoEm: { lt: cutoff } },
    data: { status: "FAILED", erro: "UPDATE_TIMEOUT_ORPHANED", finalizadoEm: now }
  });
}

function toPublic(update) {
  if (!update) return null;
  const status = {
    PENDING: "update_pending",
    DOWNLOADING: "update_downloading",
    VALIDATING: "update_validating",
    INSTALLING: "update_installing",
    RESTARTING: "update_restarting",
    SUCCESS: "update_success",
    FAILED: "update_failed",
    ROLLBACK: "update_failed"
  }[update.status] || "update_failed";
  return {
    id: update.id,
    status,
    persistentStatus: update.status,
    currentVersion: update.versaoAnterior,
    version: update.versaoDestino,
    targetVersion: update.versaoDestino,
    message: update.erro || (update.status === "SUCCESS" ? "Atualizacao concluida" : null),
    updateError: update.erro,
    rolledBack: update.status === "ROLLBACK",
    hostname: update.hostname,
    initiatedBy: update.iniciadoPor,
    updatedAt: update.atualizadoEm,
    startedAt: update.iniciadoEm,
    finishedAt: update.finalizadoEm
  };
}

async function latest(db, computadorId) {
  await recoverExpired(db);
  return db.agentUpdate.findFirst({ where: { computadorId }, orderBy: { iniciadoEm: "desc" } });
}

module.exports = {
  ACTIVE_STATUSES,
  DEFAULT_TIMEOUT_MS,
  createPending,
  findActive,
  applyAgentStatus,
  markSuccessOnRegister,
  recoverExpired,
  latest,
  toPublic,
  timeoutMs,
  isActive
};
