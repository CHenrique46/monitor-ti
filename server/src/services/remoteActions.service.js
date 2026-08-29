const crypto = require("crypto");
const prisma = require("../prisma");

const ACTIONS = {
  spooler_reset: {
    label: "Reiniciar spooler de impressão"
  }
};

const FINAL_STATUSES = new Set(["SUCCESS", "FAILED", "REJECTED"]);

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

function createRemoteActionsService(db = prisma) {
  async function createExecution({ computadorId, action }) {
    const normalizedAction = assertAllowedAction(action);
    const record = await db.acaoRemotaExecucao.create({
      data: {
        actionExecutionId: crypto.randomUUID(),
        computadorId: Number(computadorId),
        action: normalizedAction,
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

  async function applyAgentStatusMessage(msg) {
    if (!msg || !msg.actionExecutionId) return null;

    const execution = await db.acaoRemotaExecucao.findUnique({
      where: { actionExecutionId: String(msg.actionExecutionId) }
    });
    if (!execution) return null;
    if (FINAL_STATUSES.has(execution.status)) return mapExecution(execution);

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
      if (msg.result !== undefined) data.resultado = msg.result;
    }

    const updated = await db.acaoRemotaExecucao.update({
      where: { actionExecutionId: execution.actionExecutionId },
      data
    });
    return mapExecution(updated);
  }

  return {
    createExecution,
    listByComputador,
    getByActionExecutionId,
    markDispatched,
    markRejected,
    applyAgentStatusMessage
  };
}

const defaultService = createRemoteActionsService();

module.exports = {
  ACTIONS,
  createRemoteActionsService,
  ...defaultService,
  isAllowedAction,
  normalizeAction
};
