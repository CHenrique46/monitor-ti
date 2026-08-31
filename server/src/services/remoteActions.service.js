const crypto = require("crypto");
const prisma = require("../prisma");

const ACTIONS = {
  spooler_reset: {
    label: "Reiniciar spooler de impressão"
  },
  service_restart: {
    label: "Reiniciar serviço do Windows"
  },
  system_maintenance: {
    label: "Manutenção preventiva do Windows"
  }
};

const SERVICE_ALLOWLIST = Object.freeze({
  spooler: Object.freeze({
    serviceName: "Spooler",
    displayName: "Spooler de Impressão"
  })
});

const FINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REJECTED"]);
const TRANSIENT_STATUSES = ["PENDING", "DISPATCHED", "RUNNING"];
const MAX_RESULT_BYTES = 512 * 1024;
const ORPHAN_MESSAGE = "A execução foi interrompida porque o servidor foi reiniciado antes de receber a confirmação final.";

function normalizeAction(action) {
  return String(action || "").trim().toLowerCase();
}

function isAllowedAction(action) {
  return !!ACTIONS[normalizeAction(action)];
}

function assertAllowedAction(action) {
  const normalized = normalizeAction(action);
  if (!ACTIONS[normalized]) {
    throw new Error("Ação remota não suportada.");
  }
  return normalized;
}

function mapExecution(record) {
  if (!record) return null;
  return {
    id: record.id,
    actionExecutionId: record.actionExecutionId,
    computadorId: record.computadorId,
    action: record.action,
    label: ACTIONS[record.action] ? ACTIONS[record.action].label : record.action,
    payload: record.payload || null,
    status: record.status,
    mensagem: record.mensagem,
    erro: record.erro,
    resultado: record.resultado,
    solicitadaEm: record.solicitadaEm,
    enviadaEm: record.enviadaEm,
    iniciadaEm: record.iniciadaEm,
    concluidaEm: record.concluidaEm,
    atualizadoEm: record.atualizadoEm
  };
}

function validateResult(result) {
  if (result === undefined) return { ok: true, value: undefined };
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) return { ok: false, error: "resultado não serializável" };
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > MAX_RESULT_BYTES) {
      return { ok: false, error: `resultado excede o limite de ${MAX_RESULT_BYTES} bytes` };
    }
    const value = JSON.parse(serialized);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "resultado deve ser um objeto JSON" };
    }
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: "resultado contém dados inválidos" };
  }
}

async function recoverOrphanedExecutions(db = prisma) {
  const result = await db.acaoRemotaExecucao.updateMany({
    where: { status: { in: TRANSIENT_STATUSES } },
    data: {
      status: "FAILED",
      concluidaEm: new Date(),
      mensagem: ORPHAN_MESSAGE,
      erro: ORPHAN_MESSAGE
    }
  });
  return result.count || 0;
}

function createRemoteActionsService(db = prisma) {
  async function createExecution({ computadorId, action, payload = null }) {
    const normalizedAction = assertAllowedAction(action);
    if (normalizedAction === "service_restart") {
      const serviceKey = String(payload && payload.serviceKey || "").trim().toLowerCase();
      if (!SERVICE_ALLOWLIST[serviceKey]) {
        throw new Error("Serviço não permitido.");
      }
      payload = { serviceKey };
    }
    const record = await db.acaoRemotaExecucao.create({
      data: {
        actionExecutionId: crypto.randomUUID(),
        computadorId: Number(computadorId),
        action: normalizedAction,
        payload,
        status: "PENDING"
      }
    });
    return mapExecution(record);
  }

  async function listByComputador(computadorId, take = 20) {
    const items = await db.acaoRemotaExecucao.findMany({
      where: { computadorId: Number(computadorId) },
      orderBy: { solicitadaEm: "desc" },
      take: Math.max(1, Math.min(Number(take) || 20, 100))
    });
    return items.map(mapExecution);
  }

  async function getByActionExecutionId(actionExecutionId) {
    const record = await db.acaoRemotaExecucao.findUnique({
      where: { actionExecutionId: String(actionExecutionId) }
    });
    return mapExecution(record);
  }

  async function markDispatched(actionExecutionId) {
    const record = await db.acaoRemotaExecucao.updateMany({
      where: {
        actionExecutionId: String(actionExecutionId),
        status: { notIn: Array.from(FINAL_STATUSES) }
      },
      data: {
        status: "DISPATCHED",
        enviadaEm: new Date(),
        mensagem: "Solicitacao enviada ao agent."
      }
    });
    return record.count > 0;
  }

  async function markRejected(actionExecutionId, erro, mensagem) {
    const record = await db.acaoRemotaExecucao.updateMany({
      where: {
        actionExecutionId: String(actionExecutionId),
        status: { notIn: Array.from(FINAL_STATUSES) }
      },
      data: {
        status: "REJECTED",
        concluidaEm: new Date(),
        erro: String(erro || mensagem || "Falha ao enviar solicitacao.")
      }
    });
    return record.count > 0;
  }

  async function applyAgentStatusMessage(msg, { allowOrphanRecovery = false } = {}) {
    if (!msg || !msg.actionExecutionId) return null;

    const execution = await db.acaoRemotaExecucao.findUnique({
      where: { actionExecutionId: String(msg.actionExecutionId) },
      include: { computador: { select: { deviceId: true } } }
    });
    if (!execution) return null;

    if (msg.deviceId && execution.computador && execution.computador.deviceId !== msg.deviceId) return null;
    if (msg.action && normalizeAction(msg.action) !== normalizeAction(execution.action)) return null;
    if (FINAL_STATUSES.has(execution.status) && !(allowOrphanRecovery && execution.status === "FAILED" && execution.erro === ORPHAN_MESSAGE)) {
      return mapExecution(execution);
    }

    const status = String(msg.status || "").trim().toUpperCase();
    if (!["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(status)) return mapExecution(execution);

    const data = {
      status,
      mensagem: msg.message || null,
      erro: msg.error || null
    };

    if (status === "RUNNING") {
      data.iniciadaEm = execution.iniciadaEm || new Date();
    }
    if (status === "SUCCESS" || status === "FAILED" || status === "REJECTED") {
      data.concluidaEm = new Date();
      if (msg.result !== undefined) {
        const checkedResult = validateResult(msg.result);
        if (checkedResult.ok) {
          data.resultado = checkedResult.value;
        } else {
          data.erro = [msg.error, `Detalhes do resultado descartados: ${checkedResult.error}.`]
            .filter(Boolean)
            .join(" ");
        }
      }
    }

    const updated = await db.acaoRemotaExecucao.update({
      where: { actionExecutionId: execution.actionExecutionId },
      data
    });
    return mapExecution(updated);
  }

  async function reconcileAgentStatusMessage(msg) {
    if (!msg || !msg.actionExecutionId || !msg.deviceId || !msg.action) {
      return { accepted: false, execution: null, error: "Reconciliação inválida." };
    }
    const execution = await db.acaoRemotaExecucao.findUnique({
      where: { actionExecutionId: String(msg.actionExecutionId) },
      include: { computador: { select: { deviceId: true } } }
    });
    if (!execution) return { accepted: false, execution: null, error: "Execução não encontrada." };
    if (!execution.computador || execution.computador.deviceId !== msg.deviceId) {
      return { accepted: false, execution: mapExecution(execution), error: "deviceId incompatível." };
    }
    if (normalizeAction(msg.action) !== normalizeAction(execution.action)) {
      return { accepted: false, execution: mapExecution(execution), error: "action incompatível." };
    }
    const status = String(msg.status || "").trim().toUpperCase();
    if (! ["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(status)) {
      return { accepted: false, execution: mapExecution(execution), error: "status inválido." };
    }
    const updated = await applyAgentStatusMessage(msg, { allowOrphanRecovery: true });
    const accepted = !!updated && updated.status === status;
    return { accepted, execution: updated, error: accepted ? null : "Estado terminal existente não foi sobrescrito." };
  }

  return {
    createExecution,
    listByComputador,
    getByActionExecutionId,
    markDispatched,
    markRejected,
    applyAgentStatusMessage,
    reconcileAgentStatusMessage
  };
}

const defaultService = createRemoteActionsService();

module.exports = {
  ACTIONS,
  SERVICE_ALLOWLIST,
  createRemoteActionsService,
  recoverOrphanedExecutions,
  validateResult,
  MAX_RESULT_BYTES,
  TRANSIENT_STATUSES,
  ORPHAN_MESSAGE,
  ...defaultService,
  isAllowedAction,
  normalizeAction
};
