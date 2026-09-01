const crypto = require("crypto");
const prisma = require("../prisma");
const wallpaperAsset = require("./wallpaperAsset.service");

const ACTIONS = {
  spooler_reset: {
    label: "Reiniciar spooler de impressão"
  },
  service_restart: {
    label: "Reiniciar serviço do Windows"
  },
  system_maintenance: {
    label: "Manutenção preventiva do Windows"
  },
  set_wallpaper: {
    label: "Aplicar papel de parede padrão"
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
    scheduleRunId: record.scheduleRunId || null,
    solicitadaEm: record.solicitadaEm,
    enviadaEm: record.enviadaEm,
    iniciadaEm: record.iniciadaEm,
    concluidaEm: record.concluidaEm,
    atualizadoEm: record.atualizadoEm
  };
}

function sanitizeJsonValue(value, stack = new Set()) {
  if (typeof value === "string") {
    let sanitized = "";
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code === 0) {
        sanitized += String.fromCharCode(0xFFFD);
      } else if (code >= 0xD800 && code <= 0xDBFF) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xDC00 && next <= 0xDFFF) {
          sanitized += value[i] + value[i + 1];
          i += 1;
        } else {
          sanitized += String.fromCharCode(0xFFFD);
        }
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        sanitized += String.fromCharCode(0xFFFD);
      } else {
        sanitized += value[i];
      }
    }
    return sanitized;
  }
  if (value === null || typeof value !== "object") return value;
  if (stack.has(value)) throw new TypeError("resultado contém referência circular");
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeJsonValue(item, stack));
    return Object.keys(value).reduce((result, key) => {
      result[sanitizeJsonValue(key)] = sanitizeJsonValue(value[key], stack);
      return result;
    }, {});
  } finally {
    stack.delete(value);
  }
}

function findProblematicJsonCharacters(value, path = "$", findings = [], stack = new Set()) {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code === 0 || (code >= 0xD800 && code <= 0xDFFF &&
        !(code >= 0xDC00 && code <= 0xDFFF && i > 0 &&
          value.charCodeAt(i - 1) >= 0xD800 && value.charCodeAt(i - 1) <= 0xDBFF) &&
        !(code >= 0xD800 && code <= 0xDBFF && i + 1 < value.length &&
          value.charCodeAt(i + 1) >= 0xDC00 && value.charCodeAt(i + 1) <= 0xDFFF))) {
        findings.push({ path, codePoint: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`, index: i, length: value.length });
      }
    }
    return findings;
  }
  if (value === null || typeof value !== "object" || stack.has(value)) return findings;
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => findProblematicJsonCharacters(item, `${path}[${index}]`, findings, stack));
    } else {
      Object.keys(value).forEach((key) => {
        const keyPath = `${path}.${key.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
        findProblematicJsonCharacters(key, `${path}.__key`, findings, stack);
        findProblematicJsonCharacters(value[key], keyPath, findings, stack);
      });
    }
  } finally {
    stack.delete(value);
  }
  return findings;
}

function validateResult(result) {
  if (result === undefined) return { ok: true, value: undefined };
  try {
    const sanitized = sanitizeJsonValue(result);
    const serialized = JSON.stringify(sanitized);
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

async function refreshScheduleRun(db, scheduleRunId) {
  if (!scheduleRunId || !db.maintenanceScheduleRun || typeof db.maintenanceScheduleRun.findUnique !== "function") return null;
  const run = await db.maintenanceScheduleRun.findUnique({
    where: { id: Number(scheduleRunId) },
    include: { executions: { select: { status: true } } }
  });
  if (!run) return null;

  const executions = run.executions || [];
  const hasTransient = executions.some((execution) => !FINAL_STATUSES.has(execution.status));
  const failedCount = executions.filter((execution) => ["FAILED", "REJECTED"].includes(execution.status)).length;
  const successCount = executions.filter((execution) => execution.status === "SUCCESS").length;
  const skippedCount = Number(run.skippedCount) || 0;
  const targetCount = Number(run.targetCount) || 0;
  const allTargetsAccounted = executions.length + skippedCount >= targetCount;
  let status = "RUNNING";
  if (!hasTransient && allTargetsAccounted) {
    if (failedCount && (successCount || skippedCount)) status = "PARTIAL";
    else if (failedCount) status = "FAILED";
    else status = "COMPLETED";
  }

  return db.maintenanceScheduleRun.update({
    where: { id: run.id },
    data: {
      status,
      finishedAt: status === "RUNNING" ? null : (run.finishedAt || new Date()),
      dispatchedCount: executions.length,
      failedCount
    }
  });
}

async function recoverOrphanedExecutions(db = prisma) {
  const affectedRuns = typeof db.acaoRemotaExecucao.findMany === "function"
    ? await db.acaoRemotaExecucao.findMany({
      where: { status: { in: TRANSIENT_STATUSES }, scheduleRunId: { not: null } },
      select: { scheduleRunId: true }
    })
    : [];
  const result = await db.acaoRemotaExecucao.updateMany({
    where: { status: { in: TRANSIENT_STATUSES } },
    data: {
      status: "FAILED",
      concluidaEm: new Date(),
      mensagem: ORPHAN_MESSAGE,
      erro: ORPHAN_MESSAGE
    }
  });
  const runIds = new Set(affectedRuns.map((item) => item.scheduleRunId).filter(Boolean));
  for (const runId of runIds) await refreshScheduleRun(db, runId);
  return result.count || 0;
}

function createRemoteActionsService(db = prisma) {
  async function createExecution({ computadorId, action, payload = null, scheduleRunId = null }) {
    const normalizedAction = assertAllowedAction(action);
    if (normalizedAction === "service_restart") {
      const serviceKey = String(payload && payload.serviceKey || "").trim().toLowerCase();
      if (!SERVICE_ALLOWLIST[serviceKey]) {
        throw new Error("Serviço não permitido.");
      }
      payload = { serviceKey };
    }
    if (normalizedAction === "set_wallpaper") {
      wallpaperAsset.validate();
      payload = null;
    }
    const record = await db.acaoRemotaExecucao.create({
      data: {
        actionExecutionId: crypto.randomUUID(),
        computadorId: Number(computadorId),
        action: normalizedAction,
        payload,
        scheduleRunId: scheduleRunId ? Number(scheduleRunId) : null,
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
        concluidaEm: null,
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
    const status = String(msg.status || "").trim().toUpperCase();
    if (!["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(status)) return mapExecution(execution);
    const orphanRecovery = execution.status === "FAILED" && execution.erro === ORPHAN_MESSAGE;
    if (FINAL_STATUSES.has(execution.status) && !(allowOrphanRecovery && orphanRecovery && FINAL_STATUSES.has(status))) {
      return mapExecution(execution);
    }

    const data = {
      status,
      mensagem: msg.message || null,
      erro: msg.error || null
    };

    if (status === "RUNNING") {
      data.iniciadaEm = execution.iniciadaEm || new Date();
      data.concluidaEm = null;
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
    if (FINAL_STATUSES.has(status)) await refreshScheduleRun(db, updated.scheduleRunId);
    return mapExecution(updated);
  }

  async function reconcileAgentStatusMessage(msg) {
    if (!msg || !msg.actionExecutionId || !msg.deviceId || !msg.action) {
      return { accepted: false, reason: "invalid_message", execution: null, error: "Reconciliação inválida." };
    }
    const execution = await db.acaoRemotaExecucao.findUnique({
      where: { actionExecutionId: String(msg.actionExecutionId) },
      include: { computador: { select: { deviceId: true } } }
    });
    if (!execution) return { accepted: false, reason: "execution_not_found", execution: null, error: "Execução não encontrada." };
    if (!execution.computador || execution.computador.deviceId !== msg.deviceId) {
      return {
        accepted: false,
        reason: execution.computador ? "device_mismatch" : "computer_mismatch",
        execution: mapExecution(execution),
        error: execution.computador ? "deviceId incompatível." : "Computador não associado."
      };
    }
    if (normalizeAction(msg.action) !== normalizeAction(execution.action)) {
      return { accepted: false, reason: "action_mismatch", execution: mapExecution(execution), error: "action incompatível." };
    }
    const status = String(msg.status || "").trim().toUpperCase();
    if (! ["RUNNING", "SUCCESS", "FAILED", "REJECTED"].includes(status)) {
      return { accepted: false, reason: "invalid_status", execution: mapExecution(execution), error: "status inválido." };
    }
    const orphanRecovery = execution.status === "FAILED" && execution.erro === ORPHAN_MESSAGE;
    if (orphanRecovery && status === "RUNNING") {
      return {
        accepted: false,
        reason: "terminal_state_cannot_reopen",
        execution: mapExecution(execution),
        error: "Estado terminal de recovery não pode ser reaberto."
      };
    }
    if (FINAL_STATUSES.has(execution.status) && !orphanRecovery) {
      return {
        accepted: false,
        reason: "terminal_conflict",
        execution: mapExecution(execution),
        error: "Estado terminal existente não foi sobrescrito."
      };
    }
    if (["SUCCESS", "FAILED", "REJECTED"].includes(status) && msg.result !== undefined) {
      const checkedResult = validateResult(msg.result);
      if (!checkedResult.ok) {
        return {
          accepted: false,
          reason: "invalid_result",
          execution: mapExecution(execution),
          error: `Resultado rejeitado: ${checkedResult.error}.`
        };
      }
    }
    const updated = await applyAgentStatusMessage(msg, { allowOrphanRecovery: true });
    const accepted = !!updated && updated.status === status;
    return {
      accepted,
      reason: accepted ? null : "transition_rejected",
      execution: updated,
      error: accepted ? null : "Estado terminal existente não foi sobrescrito."
    };
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
  refreshScheduleRun,
  validateResult,
  sanitizeJsonValue,
  findProblematicJsonCharacters,
  MAX_RESULT_BYTES,
  TRANSIENT_STATUSES,
  ORPHAN_MESSAGE,
  ...defaultService,
  isAllowedAction,
  normalizeAction
};
