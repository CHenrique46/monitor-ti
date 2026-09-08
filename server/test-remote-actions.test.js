const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createRemoteActionsService,
  recoverOrphanedExecutions,
  ORPHAN_MESSAGE,
  refreshScheduleRun,
  TRANSIENT_STATUSES,
  MAX_RESULT_BYTES,
  sanitizeJsonValue,
  findProblematicJsonCharacters
} = require("./src/services/remoteActions.service");
const { createRemoteActionsController } = require("./src/controllers/remoteActions.controller");

function createMockDb() {
  const computers = [
    { id: 1, deviceId: "dev-1", hostname: "PC-1", status: "online" },
    { id: 2, deviceId: "dev-2", hostname: "PC-2", status: "offline" }
  ];
  const executions = [];
  let nextId = 1;

  function clone(v) {
    return v ? JSON.parse(JSON.stringify(v)) : v;
  }

  function pick(record, select) {
    if (!select) return clone(record);
    const out = {};
    for (const key of Object.keys(select)) {
      if (select[key]) out[key] = record[key];
    }
    return out;
  }

  return {
    computers,
    executions,
    computador: {
      findUnique: async ({ where, select }) => {
        let found = null;
        if (where.id != null) found = computers.find((c) => c.id === Number(where.id)) || null;
        if (where.deviceId != null) found = computers.find((c) => c.deviceId === where.deviceId) || null;
        return found ? pick(found, select) : null;
      }
    },
    acaoRemotaExecucao: {
      create: async ({ data }) => {
        const record = {
          id: nextId++,
          solicitado: data.solicitado || null,
          ...data,
          solicitadaEm: new Date(),
          enviadoEm: null,
          enviadaEm: null,
          iniciadaEm: null,
          concluidaEm: null,
          atualizadoEm: new Date()
        };
        executions.push(record);
        return clone(record);
      },
      findMany: async ({ where, orderBy, take }) => {
        let items = executions.filter((e) => e.computadorId === Number(where.computadorId));
        if (orderBy && orderBy.solicitadaEm === "desc") {
          items = items.slice().reverse();
        }
        if (take != null) items = items.slice(0, take);
        return items.map(clone);
      },
      findFirst: async ({ where }) => {
        const found = executions.find((e) => e.computadorId === Number(where.computadorId) && e.action === where.action && where.status.in.includes(e.status));
        return found ? { actionExecutionId: found.actionExecutionId } : null;
      },
      findUnique: async ({ where }) => {
        const found = executions.find((e) => e.actionExecutionId === String(where.actionExecutionId));
        return found ? clone(found) : null;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const e of executions) {
          if (e.actionExecutionId !== String(where.actionExecutionId)) continue;
          if (where.status && Array.isArray(where.status.notIn) && where.status.notIn.includes(e.status)) continue;
          Object.assign(e, data, { atualizadoEm: new Date() });
          count += 1;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const found = executions.find((e) => e.actionExecutionId === String(where.actionExecutionId));
        if (!found) throw new Error("not found");
        Object.assign(found, data, { atualizadoEm: new Date() });
        return clone(found);
      }
    }
  };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    }
  };
}

test("server remote actions workflow and history", async () => {
  const db = createMockDb();
  const service = createRemoteActionsService(db);
  const sent = [];
  const controller = createRemoteActionsController({
    prisma: db,
    agentServer: {
      sendToAgent: (deviceId, payload) => {
        sent.push({ deviceId, payload });
        return true;
      }
    },
    remoteActionsService: service
  });

  const missing = makeRes();
  await controller.spoolerReset({ params: { id: 999 } }, missing);
  assert.equal(missing.statusCode, 404);

  const offline = makeRes();
  await controller.spoolerReset({ params: { id: 2 } }, offline);
  assert.equal(offline.statusCode, 409);
  assert.equal(offline.body.execution.status, "REJECTED");
  assert.equal(sent.length, 0);

  const ok = makeRes();
  await controller.spoolerReset({ params: { id: 1 } }, ok);
  assert.equal(ok.statusCode, 202);
  assert.equal(ok.body.execution.status, "DISPATCHED");
  assert.equal(sent.length, 1);

  const executionId = ok.body.execution.actionExecutionId;
  let state = await service.applyAgentStatusMessage({
    actionExecutionId: executionId,
    status: "RUNNING",
    message: "Executando"
  });
  assert.equal(state.status, "RUNNING");

  state = await service.applyAgentStatusMessage({
    actionExecutionId: executionId,
    status: "SUCCESS",
    message: "Ok",
    result: { spooler: "restarted" }
  });
  assert.equal(state.status, "SUCCESS");

  const duplicate = await service.applyAgentStatusMessage({
    actionExecutionId: executionId,
    status: "SUCCESS",
    message: "Ok"
  });
  assert.equal(duplicate.status, "SUCCESS");
  assert.equal(db.executions.filter((e) => e.actionExecutionId === executionId).length, 1);

  const rejected = await service.applyAgentStatusMessage({
    actionExecutionId: executionId,
    status: "REJECTED",
    message: "nao suportado"
  });
  assert.equal(rejected.status, "SUCCESS");

  const unknown = await service.applyAgentStatusMessage({
    actionExecutionId: "missing-id",
    status: "RUNNING"
  });
  assert.equal(unknown, null);

  const historyRes = makeRes();
  await controller.list({ params: { id: 1 }, query: { take: 10 } }, historyRes);
  assert.equal(Array.isArray(historyRes.body), true);
  assert.ok(historyRes.body.length >= 1);
  assert.equal(historyRes.body[0].action, "spooler_reset");
});

test("server service_restart valida chave, offline e payload persistido", async () => {
  const db = createMockDb();
  const service = createRemoteActionsService(db);
  const sent = [];
  const controller = createRemoteActionsController({
    prisma: db,
    agentServer: {
      sendToAgent: (deviceId, payload) => {
        sent.push({ deviceId, payload });
        return true;
      }
    },
    remoteActionsService: service
  });

  const invalid = makeRes();
  await controller.serviceRestart(
    { params: { id: 1 }, body: { serviceKey: "arbitrary" } },
    invalid
  );
  assert.equal(invalid.statusCode, 400);
  assert.equal(db.executions.length, 0);

  const offline = makeRes();
  await controller.serviceRestart(
    { params: { id: 2 }, body: { serviceKey: "spooler" } },
    offline
  );
  assert.equal(offline.statusCode, 409);
  assert.equal(offline.body.execution.status, "REJECTED");
  assert.deepEqual(db.executions[0].payload, { serviceKey: "spooler" });

  const valid = makeRes();
  await controller.serviceRestart(
    { params: { id: 1 }, body: { serviceKey: "spooler" } },
    valid
  );
  assert.equal(valid.statusCode, 202);
  assert.equal(valid.body.execution.action, "service_restart");
  assert.deepEqual(valid.body.execution.payload, { serviceKey: "spooler" });
  assert.equal(sent[0].payload.payload.serviceKey, "spooler");
});

test("server service rejects unknown actions", async () => {
  const db = createMockDb();
  const service = createRemoteActionsService(db);
  await assert.rejects(
    () => service.createExecution({ computadorId: 1, action: "rm_rf" }),
    /Ação remota não suportada/
  );
});

test("server system_maintenance usa acao fixa e rejeita computador offline", async () => {
  const db = createMockDb();
  const service = createRemoteActionsService(db);
  const sent = [];
  const controller = createRemoteActionsController({
    prisma: db,
    agentServer: {
      sendToAgent: (deviceId, payload) => {
        sent.push({ deviceId, payload });
        return true;
      }
    },
    remoteActionsService: service
  });

  const offline = makeRes();
  await controller.systemMaintenance({ params: { id: 2 }, body: {} }, offline);
  assert.equal(offline.statusCode, 409);
  assert.equal(offline.body.execution.action, "system_maintenance");
  assert.equal(offline.body.execution.status, "REJECTED");
  assert.equal(sent.length, 0);

  const online = makeRes();
  await controller.systemMaintenance({ params: { id: 1 }, body: {} }, online);
  assert.equal(online.statusCode, 202);
  assert.equal(online.body.execution.action, "system_maintenance");
  assert.equal(online.body.execution.payload, null);
  assert.equal(sent[0].payload.action, "system_maintenance");
  assert.deepEqual(sent[0].payload.payload, {});
});

test("server disk_cleanup_analyze usa ação fixa, ignora payload arbitrário e evita duplicidade", async () => {
  const db = createMockDb();
  const service = createRemoteActionsService(db);
  const sent = [];
  const controller = createRemoteActionsController({
    prisma: db,
    agentServer: { hasCapability: () => true, sendToAgent: (deviceId, payload) => { sent.push({ deviceId, payload }); return true; } },
    remoteActionsService: service
  });
  const response = makeRes();
  await controller.diskCleanupAnalyze({ params: { id: 1 }, body: { path: "C:\\Users\\*", command: "del" } }, response);
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.execution.action, "disk_cleanup_analyze");
  assert.deepEqual(sent[0].payload.payload, {});

  const duplicate = makeRes();
  await controller.diskCleanupAnalyze({ params: { id: 1 }, body: {} }, duplicate);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(db.executions.length, 1);
});

test("server bloqueia disk_cleanup_analyze sem capability antes de criar ou enviar", async () => {
  const db = createMockDb();
  let createCalls = 0;
  let sendCalls = 0;
  const controller = createRemoteActionsController({
    prisma: db,
    agentServer: { hasCapability: () => false, sendToAgent: () => { sendCalls += 1; return true; } },
    remoteActionsService: {
      hasActiveExecution: async () => false,
      createExecution: async () => { createCalls += 1; throw new Error("nao deveria criar"); }
    }
  });
  const response = makeRes();
  await controller.diskCleanupAnalyze({ params: { id: 1 }, body: {} }, response);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, { error: "AGENT_CAPABILITY_UNSUPPORTED", capability: "disk_cleanup_analyze" });
  assert.equal(createCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(db.executions.length, 0);
});

test("server persiste status terminal quando result e invalido ou grande", async () => {
  const updates = [];
  const record = {
    id: 1,
    actionExecutionId: "result-invalid",
    computadorId: 1,
    action: "system_maintenance",
    payload: null,
    status: "RUNNING",
    mensagem: null,
    erro: null,
    resultado: null,
    iniciadaEm: new Date()
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => record,
      update: async ({ data }) => {
        updates.push(data);
        Object.assign(record, data);
        return record;
      }
    }
  };
  const service = createRemoteActionsService(db);
  const circular = {};
  circular.self = circular;
  const invalid = await service.applyAgentStatusMessage({
    actionExecutionId: "result-invalid",
    status: "SUCCESS",
    message: "concluido",
    result: circular
  });

  assert.equal(invalid.status, "SUCCESS");
  assert.equal(invalid.resultado, null);
  assert.match(invalid.erro, /resultado descartados/);
  assert.ok(updates[0].concluidaEm);

  record.status = "RUNNING";
  const large = await service.applyAgentStatusMessage({
    actionExecutionId: "result-invalid",
    status: "SUCCESS",
    result: { steps: [{ key: "sfc", output: "x".repeat(MAX_RESULT_BYTES) }] }
  });
  assert.equal(large.status, "SUCCESS");
  assert.match(large.erro, /excede o limite/);
});

test("server recupera PENDING DISPATCHED e RUNNING sem alterar estados terminais", async () => {
  const records = [
    { actionExecutionId: "pending", status: "PENDING" },
    { actionExecutionId: "dispatched", status: "DISPATCHED" },
    { actionExecutionId: "running", status: "RUNNING" },
    { actionExecutionId: "success", status: "SUCCESS" },
    { actionExecutionId: "failed", status: "FAILED" },
    { actionExecutionId: "rejected", status: "REJECTED" }
  ];
  const db = {
    acaoRemotaExecucao: {
      updateMany: async ({ where, data }) => {
        assert.deepEqual(where.status.in, ["PENDING", "DISPATCHED", "RUNNING"]);
        let count = 0;
        for (const record of records) {
          if (!where.status.in.includes(record.status)) continue;
          Object.assign(record, data);
          count += 1;
        }
        return { count };
      }
    }
  };
  const count = await recoverOrphanedExecutions(db);

  assert.equal(count, 3);
  assert.equal(records.filter((record) => record.status === "FAILED").length, 4);
  assert.equal(records.find((record) => record.actionExecutionId === "success").status, "SUCCESS");
  assert.equal(records.find((record) => record.actionExecutionId === "rejected").status, "REJECTED");
  assert.equal(records.find((record) => record.actionExecutionId === "running").mensagem, ORPHAN_MESSAGE);
});

test("server reconcilia terminal real, valida identidade e preserva FAILED legítimo", async () => {
  const base = {
    id: 10,
    actionExecutionId: "reconcile-1",
    computadorId: 15,
    action: "system_maintenance",
    status: "RUNNING",
    mensagem: null,
    erro: null,
    resultado: null,
    iniciadaEm: new Date(),
    computador: { deviceId: "dev-15" }
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => base,
      update: async ({ data }) => Object.assign(base, data)
    }
  };
  const service = createRemoteActionsService(db);
  const success = await service.reconcileAgentStatusMessage({
    actionExecutionId: "reconcile-1",
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    message: "concluido",
    result: { overallStatus: "SUCCESS" }
  });

  assert.equal(success.accepted, true);
  assert.equal(success.execution.status, "SUCCESS");
  assert.ok(success.execution.concluidaEm);

  base.status = "FAILED";
  base.erro = "falha real";
  const lateSuccess = await service.reconcileAgentStatusMessage({
    actionExecutionId: "reconcile-1",
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    result: { overallStatus: "SUCCESS" }
  });
  assert.equal(lateSuccess.accepted, false);
  assert.equal(lateSuccess.reason, "terminal_conflict");
  assert.equal(base.status, "FAILED");
});

test("server permite terminal real substituir FAILED criado pelo orphan recovery", async () => {
  const record = {
    id: 12,
    actionExecutionId: "orphan-reconcile-1",
    computadorId: 15,
    action: "system_maintenance",
    status: "FAILED",
    mensagem: ORPHAN_MESSAGE,
    erro: ORPHAN_MESSAGE,
    resultado: null,
    computador: { deviceId: "dev-15" }
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => record,
      update: async ({ data }) => Object.assign(record, data)
    }
  };
  const service = createRemoteActionsService(db);
  const result = await service.reconcileAgentStatusMessage({
    actionExecutionId: "orphan-reconcile-1",
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    result: { overallStatus: "SUCCESS", steps: [] }
  });

  assert.equal(result.accepted, true);
  assert.equal(record.status, "SUCCESS");
  assert.deepEqual(record.resultado, { overallStatus: "SUCCESS", steps: [] });
});

test("server rejeita reconciliacao inexistente, deviceId e action incompatíveis", async () => {
  const records = {
    "known-1": {
      id: 11,
      actionExecutionId: "known-1",
      computadorId: 15,
      action: "system_maintenance",
      status: "RUNNING",
      erro: null,
      computador: { deviceId: "dev-15" }
    }
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async ({ where }) => records[where.actionExecutionId] || null,
      update: async ({ data }) => Object.assign(records["known-1"], data)
    }
  };
  const service = createRemoteActionsService(db);
  const cases = [
    { actionExecutionId: "missing", deviceId: "dev-15", action: "system_maintenance", status: "SUCCESS", error: "Execução não encontrada." },
    { actionExecutionId: "known-1", deviceId: "dev-other", action: "system_maintenance", status: "SUCCESS", error: "deviceId incompatível." },
    { actionExecutionId: "known-1", deviceId: "dev-15", action: "spooler_reset", status: "SUCCESS", error: "action incompatível." },
    { actionExecutionId: "known-1", deviceId: "dev-15", action: "system_maintenance", status: "INVALID", error: "status inválido." }
  ];
  for (const item of cases) {
    const result = await service.reconcileAgentStatusMessage(item);
    assert.equal(result.accepted, false);
    assert.equal(result.error, item.error);
  }
});

test("server rejeita resultado inválido na reconciliação sem alterar a execução", async () => {
  const record = {
    id: 13,
    actionExecutionId: "invalid-reconcile-result",
    computadorId: 15,
    action: "system_maintenance",
    status: "FAILED",
    mensagem: ORPHAN_MESSAGE,
    erro: ORPHAN_MESSAGE,
    resultado: null,
    computador: { deviceId: "dev-15" }
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => record,
      update: async ({ data }) => Object.assign(record, data)
    }
  };
  const circular = {};
  circular.self = circular;
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    result: circular
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "invalid_result");
  assert.equal(record.status, "FAILED");
  assert.equal(record.resultado, null);
});

test("sanitiza Unicode inválido recursivamente e preserva Unicode válido", () => {
  const value = {
    overallStatus: "SUCCESS",
    steps: [{
      name: "etapa á 😀",
      status: "SUCCESS",
      message: "linha 1\r\nlinha 2",
      output: "alto:\uD800 baixo:\uDC00 válido:\uD83D\uDE00 controle:\u0001"
    }],
    blockedFiles: ["arquivo:\uD800", "normal"],
    notification: { message: "concluído ✅" },
    rebootRecommended: true
  };
  const sanitized = sanitizeJsonValue(value);
  assert.equal(sanitized.steps[0].name, "etapa á 😀");
  assert.equal(sanitized.steps[0].output, "alto:\uFFFD baixo:\uFFFD válido:\uD83D\uDE00 controle:\u0001");
  assert.equal(sanitized.blockedFiles[0], "arquivo:\uFFFD");
  assert.equal(sanitized.notification.message, "concluído ✅");
  assert.equal(sanitized.rebootRecommended, true);
  assert.deepEqual(JSON.parse(JSON.stringify(sanitized)), sanitized);
  assert.deepEqual(findProblematicJsonCharacters(value).map(({ path, codePoint, index, length }) => ({ path, codePoint, index, length })), [
    { path: "$.steps[0].output", codePoint: "U+D800", index: 5, length: 35 },
    { path: "$.steps[0].output", codePoint: "U+DC00", index: 13, length: 35 },
    { path: "$.blockedFiles[0]", codePoint: "U+D800", index: 8, length: 9 }
  ]);
});

test("resultado reconciliado com surrogate inválido persiste sanitizado", async () => {
  const record = {
    id: 14,
    actionExecutionId: "orphan-unicode-success",
    computadorId: 15,
    action: "system_maintenance",
    status: "FAILED",
    mensagem: ORPHAN_MESSAGE,
    erro: ORPHAN_MESSAGE,
    resultado: null,
    computador: { deviceId: "dev-15" }
  };
  const updates = [];
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => record,
      update: async ({ data }) => {
        updates.push(data);
        Object.assign(record, data);
        return record;
      }
    }
  };
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    message: "Manutenção concluída 😀",
    result: {
      overallStatus: "SUCCESS",
      steps: [{ name: "SFC", status: "SUCCESS", output: "corrompido:\uD800" }],
      rebootRecommended: true
    },
    finishedAt: "2026-08-31T18:00:00.000Z"
  });

  assert.equal(result.accepted, true);
  assert.equal(record.status, "SUCCESS");
  assert.equal(record.resultado.steps[0].output, "corrompido:\uFFFD");
  assert.equal(updates.length, 1);
});

test("orphan FAILED reconciliado com FAILED real preserva resultado sanitizado", async () => {
  const record = {
    id: 15,
    actionExecutionId: "orphan-unicode-failed",
    computadorId: 15,
    action: "system_maintenance",
    status: "FAILED",
    mensagem: ORPHAN_MESSAGE,
    erro: ORPHAN_MESSAGE,
    resultado: null,
    computador: { deviceId: "dev-15" }
  };
  const db = {
    acaoRemotaExecucao: {
      findUnique: async () => record,
      update: async ({ data }) => Object.assign(record, data)
    }
  };
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "FAILED",
    message: "Falha real na etapa DISM:\uD800",
    result: { overallStatus: "FAILED", steps: [{ name: "DISM", status: "FAILED", message: "erro:\uDC00" }] }
  });

  assert.equal(result.accepted, true);
  assert.equal(record.status, "FAILED");
  assert.equal(record.mensagem, "Falha real na etapa DISM:\uD800");
  assert.equal(record.resultado.steps[0].message, "erro:\uFFFD");
  assert.notEqual(record.erro, ORPHAN_MESSAGE);
});

function makeScheduleRecord(status, overrides = {}) {
  return {
    id: 20,
    actionExecutionId: `schedule-${status.toLowerCase()}`,
    computadorId: 15,
    action: "system_maintenance",
    status,
    mensagem: status === "FAILED" ? ORPHAN_MESSAGE : null,
    erro: status === "FAILED" ? ORPHAN_MESSAGE : null,
    resultado: null,
    concluidaEm: ["SUCCESS", "FAILED", "REJECTED"].includes(status) ? new Date() : null,
    scheduleRunId: 30,
    computador: { deviceId: "dev-15" },
    ...overrides
  };
}

function makeScheduleRunDb(records, targetCount = records.length) {
  const run = {
    id: 30,
    scheduleId: 1,
    scheduledFor: new Date("2026-09-03T23:00:00.000Z"),
    startedAt: new Date(),
    finishedAt: null,
    status: "RUNNING",
    targetCount,
    dispatchedCount: 0,
    skippedCount: Math.max(0, targetCount - records.length),
    failedCount: 0
  };
  const db = {
    acaoRemotaExecucao: {
      findMany: async ({ where }) => records.filter((record) => where.status.in.includes(record.status) && record.scheduleRunId === (where.scheduleRunId && where.scheduleRunId.not !== undefined ? record.scheduleRunId : where.scheduleRunId)),
      findUnique: async () => records[0] || null,
      update: async ({ data }) => Object.assign(records[0], data),
      updateMany: async ({ data }) => {
        let count = 0;
        for (const record of records) {
          if (!TRANSIENT_STATUSES.includes(record.status)) continue;
          Object.assign(record, data);
          count += 1;
        }
        return { count };
      }
    },
    maintenanceScheduleRun: {
      findUnique: async () => ({ ...run, executions: records.map((record) => ({ status: record.status })) }),
      update: async ({ data }) => Object.assign(run, data)
    }
  };
  return { db, run };
}

test("reconciliation não reabre FAILED sintético com RUNNING", async () => {
  const record = makeScheduleRecord("FAILED");
  const { db, run } = makeScheduleRunDb([record]);
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "RUNNING"
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "terminal_state_cannot_reopen");
  assert.equal(record.status, "FAILED");
  assert.ok(record.concluidaEm);
  assert.equal(run.status, "RUNNING");
});

test("FAILED sintético aceita SUCCESS e recalcula run", async () => {
  const record = makeScheduleRecord("FAILED");
  const { db, run } = makeScheduleRunDb([record], 1);
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "SUCCESS",
    result: { overallStatus: "SUCCESS", steps: [] }
  });
  assert.equal(result.accepted, true);
  assert.equal(record.status, "SUCCESS");
  assert.deepEqual(record.resultado, { overallStatus: "SUCCESS", steps: [] });
  assert.equal(run.status, "COMPLETED");
});

test("FAILED sintético aceita FAILED terminal real", async () => {
  const record = makeScheduleRecord("FAILED");
  const { db } = makeScheduleRunDb([record]);
  const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
    actionExecutionId: record.actionExecutionId,
    deviceId: "dev-15",
    action: "system_maintenance",
    status: "FAILED",
    error: "falha real",
    result: { overallStatus: "FAILED", steps: [] }
  });
  assert.equal(result.accepted, true);
  assert.equal(record.status, "FAILED");
  assert.equal(record.erro, "falha real");
});

test("estados terminais SUCCESS e REJECTED não são reabertos por RUNNING", async () => {
  for (const status of ["SUCCESS", "REJECTED"]) {
    const record = makeScheduleRecord(status, { actionExecutionId: `terminal-${status}` });
    const { db } = makeScheduleRunDb([record]);
    const result = await createRemoteActionsService(db).reconcileAgentStatusMessage({
      actionExecutionId: record.actionExecutionId,
      deviceId: "dev-15",
      action: "system_maintenance",
      status: "RUNNING"
    });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, "terminal_conflict");
    assert.equal(record.status, status);
  }
});

test("RUNNING limpa concluidaEm e refresh de run mantém RUNNING", async () => {
  const record = makeScheduleRecord("DISPATCHED", { concluidaEm: new Date() });
  const { db, run } = makeScheduleRunDb([record]);
  const service = createRemoteActionsService(db);
  const state = await service.applyAgentStatusMessage({ actionExecutionId: record.actionExecutionId, status: "RUNNING" });
  assert.equal(state.status, "RUNNING");
  assert.equal(record.concluidaEm, null);
  await refreshScheduleRun(db, run.id);
  assert.equal(run.status, "RUNNING");
  assert.equal(run.finishedAt, null);
});

test("refreshScheduleRun calcula terminal, partial e é idempotente", async () => {
  const success = makeScheduleRecord("SUCCESS", { actionExecutionId: "multi-success" });
  const failed = makeScheduleRecord("FAILED", { actionExecutionId: "multi-failed", mensagem: "falha real", erro: "falha real" });
  const { db, run } = makeScheduleRunDb([success, failed], 2);
  await refreshScheduleRun(db, run.id);
  assert.equal(run.status, "PARTIAL");
  assert.equal(run.dispatchedCount, 2);
  assert.equal(run.failedCount, 1);
  const firstFinishedAt = run.finishedAt;
  await refreshScheduleRun(db, run.id);
  assert.equal(run.status, "PARTIAL");
  assert.equal(run.dispatchedCount, 2);
  assert.equal(run.failedCount, 1);
  assert.equal(run.finishedAt, firstFinishedAt);
});

test("recovery de ação vinculada recalcula o schedule run", async () => {
  const record = makeScheduleRecord("RUNNING");
  const { db, run } = makeScheduleRunDb([record], 1);
  const count = await recoverOrphanedExecutions(db);
  assert.equal(count, 1);
  assert.equal(record.status, "FAILED");
  assert.equal(run.status, "FAILED");
  assert.ok(run.finishedAt);
});
