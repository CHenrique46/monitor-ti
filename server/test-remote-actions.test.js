const test = require("node:test");
const assert = require("node:assert/strict");

const { createRemoteActionsService } = require("./src/services/remoteActions.service");
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
