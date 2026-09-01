const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateNextExecution,
  createMaintenanceScheduler,
  DEFAULT_TIMEZONE,
  getDueExecution,
  isCompatibleAgent
} = require("./src/services/maintenanceScheduler.service");

const baseSchedule = {
  id: 1,
  enabled: true,
  name: "Manutenção semanal",
  dayOfWeek: 4,
  time: "20:00",
  timezone: DEFAULT_TIMEZONE,
  targetMode: "ALL",
  targets: []
};

function makeDb(computers, busyIds = []) {
  return {
    computador: {
      findMany: async ({ where }) => {
        const ids = where && where.id && where.id.in;
        return computers.filter((computer) => !ids || ids.includes(computer.id));
      }
    },
    acaoRemotaExecucao: {
      findMany: async () => busyIds.map((computadorId) => ({ computadorId }))
    }
  };
}

function makeCycleScheduler({ schedule = { ...baseSchedule, enabled: false, targetMode: "SELECTED", targets: [{ computadorId: 15 }] }, computers = [{ id: 15, hostname: "Anderson", deviceId: "anderson", status: "online", agentVersion: "1.1.14-dev" }], busyIds = [] } = {}) {
  const state = { runs: [], actions: [], dispatches: [] };
  const db = {
    maintenanceSchedule: {
      findUnique: async ({ where }) => Number(where.id) === schedule.id ? schedule : null,
      findMany: async ({ where }) => where && where.enabled === true && schedule.enabled ? [schedule] : []
    },
    computador: {
      findMany: async ({ where }) => {
        const ids = where && where.id && where.id.in;
        return computers.filter((computer) => !ids || ids.includes(computer.id));
      }
    },
    acaoRemotaExecucao: {
      findMany: async () => busyIds.map((computadorId) => ({ computadorId }))
    },
    maintenanceScheduleRun: {
      create: async ({ data }) => {
        if (state.runs.some((run) => run.scheduleId === data.scheduleId && run.scheduledFor.getTime() === data.scheduledFor.getTime())) {
          const error = new Error("ciclo duplicado");
          error.code = "P2002";
          throw error;
        }
        const run = { id: state.runs.length + 1, ...data };
        state.runs.push(run);
        return run;
      },
      findUnique: async () => ({ ...state.runs[0], executions: state.actions.map((action) => ({ status: action.status })) }),
      update: async ({ data }) => Object.assign(state.runs[0], data)
    }
  };
  const scheduler = createMaintenanceScheduler({
    db,
    remoteActions: {
      createExecution: async (data) => {
        const action = { id: state.actions.length + 1, actionExecutionId: `scheduled-${state.actions.length + 1}`, status: "PENDING", ...data };
        state.actions.push(action);
        return action;
      },
      markDispatched: async (actionExecutionId) => {
        state.actions.find((action) => action.actionExecutionId === actionExecutionId).status = "DISPATCHED";
        return true;
      },
      markRejected: async () => true
    },
    ws: { sendToAgent: (deviceId, payload) => { state.dispatches.push({ deviceId, payload }); return true; } },
    log: () => {}
  });
  return { scheduler, state };
}

test("calcula a próxima quinta-feira às 20:00 em America/Sao_Paulo", () => {
  const next = calculateNextExecution(baseSchedule, new Date("2026-09-03T18:00:00-03:00"));
  assert.equal(next.toISOString(), "2026-09-03T23:00:00.000Z");
});

test("depois do horário e na mudança de dia calcula o ciclo seguinte", () => {
  const after = calculateNextExecution(baseSchedule, new Date("2026-09-03T21:00:00-03:00"));
  const friday = calculateNextExecution(baseSchedule, new Date("2026-09-04T09:00:00-03:00"));
  assert.equal(after.toISOString(), "2026-09-10T23:00:00.000Z");
  assert.equal(friday.toISOString(), "2026-09-10T23:00:00.000Z");
});

test("janela de vencimento só fica ativa no minuto do agendamento", () => {
  assert.ok(getDueExecution(baseSchedule, new Date("2026-09-03T20:00:30-03:00")));
  assert.equal(getDueExecution(baseSchedule, new Date("2026-09-03T20:02:00-03:00")), null);
});

test("agendamento disabled não entra no tick e não despacha", async () => {
  let dispatches = 0;
  const scheduler = createMaintenanceScheduler({
    db: { maintenanceSchedule: { findMany: async () => [] } },
    ws: { sendToAgent: () => { dispatches += 1; return true; } }
  });
  await scheduler.tick(new Date("2026-09-03T20:00:30-03:00"));
  assert.equal(dispatches, 0);
});

test("plano marca offline e ação em andamento como inelegíveis", async () => {
  const computers = [
    { id: 1, hostname: "Online", deviceId: "d1", status: "online", agentVersion: "1.1.14-dev" },
    { id: 2, hostname: "Offline", deviceId: "d2", status: "offline", agentVersion: "1.1.14-dev" },
    { id: 3, hostname: "Busy", deviceId: "d3", status: "online", agentVersion: "1.1.14-dev" }
  ];
  const scheduler = createMaintenanceScheduler({ db: makeDb(computers, [3]) });
  const plan = await scheduler.buildPlan(baseSchedule, new Date("2026-09-03T18:00:00-03:00"));
  assert.equal(plan.eligibleCount, 1);
  assert.equal(plan.offlineCount, 1);
  assert.equal(plan.inProgressCount, 1);
  assert.equal(plan.machines.find((machine) => machine.id === 2).reason, "offline");
  assert.equal(plan.machines.find((machine) => machine.id === 3).reason, "action_in_progress");
});

test("SELECTED considera somente computadores escolhidos", async () => {
  const computers = [
    { id: 1, hostname: "Escolhido", deviceId: "d1", status: "online", agentVersion: "1.1.14-dev" },
    { id: 2, hostname: "Fora", deviceId: "d2", status: "online", agentVersion: "1.1.14-dev" }
  ];
  const scheduler = createMaintenanceScheduler({ db: makeDb(computers) });
  const plan = await scheduler.buildPlan({ ...baseSchedule, targetMode: "SELECTED", targets: [{ computadorId: 1 }] }, new Date());
  assert.deepEqual(plan.machines.map((machine) => machine.id), [1]);
});

test("ALL seleciona máquinas elegíveis e Agent compatível", async () => {
  const computers = [
    { id: 1, hostname: "Compatível", deviceId: "d1", status: "online", agentVersion: "1.1.14-dev" },
    { id: 2, hostname: "Antigo", deviceId: "d2", status: "online", agentVersion: "1.0.9" }
  ];
  const scheduler = createMaintenanceScheduler({ db: makeDb(computers) });
  const plan = await scheduler.buildPlan(baseSchedule, new Date());
  assert.equal(plan.eligibleCount, 1);
  assert.equal(plan.machines.find((machine) => machine.id === 2).reason, "incompatible_agent");
  assert.equal(isCompatibleAgent("1.1.14-dev"), true);
});

test("dry-run calcula sem criar ciclo nem chamar dispatch", async () => {
  let created = 0;
  let dispatched = 0;
  const schedule = { ...baseSchedule, targets: [] };
  const scheduler = createMaintenanceScheduler({
    db: {
      maintenanceSchedule: {
        findUnique: async () => schedule,
        findMany: async () => []
      },
      computador: { findMany: async () => [] },
      acaoRemotaExecucao: { findMany: async () => [] },
      maintenanceScheduleRun: { create: async () => { created += 1; } }
    },
    ws: { sendToAgent: () => { dispatched += 1; return true; } }
  });
  const result = await scheduler.dryRunSchedule(1, new Date("2026-09-03T18:00:00-03:00"));
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(created, 0);
  assert.equal(dispatched, 0);
});

test("ciclo controlado aceita schedule disabled sem alterar a policy", async () => {
  const { scheduler, state } = makeCycleScheduler();
  const result = await scheduler.runScheduleCycle({
    scheduleId: 1,
    scheduledFor: "2026-09-03T23:00:00.000Z",
    dryRun: true,
    requireEnabled: false
  });
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.targetCount, 1);
  assert.equal(result.eligibleCount, 1);
  assert.equal(state.runs.length, 0);
  assert.equal(state.actions.length, 0);
  assert.equal(state.dispatches.length, 0);
});

test("ciclo controlado real cria run e ação idempotentes", async () => {
  const { scheduler, state } = makeCycleScheduler();
  const input = { scheduleId: 1, scheduledFor: new Date("2026-09-03T23:00:00.000Z"), dryRun: false, requireEnabled: false };
  const first = await scheduler.runScheduleCycle(input);
  const second = await scheduler.runScheduleCycle(input);
  assert.equal(first.mode, "REAL");
  assert.equal(first.dispatched, 1);
  assert.equal(first.skipped, 0);
  assert.equal(second.duplicate, true);
  assert.equal(state.runs.length, 1);
  assert.equal(state.actions.length, 1);
  assert.equal(state.actions[0].action, "system_maintenance");
  assert.equal(state.actions[0].scheduleRunId, state.runs[0].id);
  assert.equal(state.dispatches.length, 1);
  assert.equal(state.runs[0].status, "RUNNING");
});

test("ciclo controlado valida identificador e scheduledFor", async () => {
  const { scheduler } = makeCycleScheduler();
  await assert.rejects(() => scheduler.runScheduleCycle({ scheduleId: 999, scheduledFor: "2026-09-03T23:00:00Z", dryRun: true, requireEnabled: false }), /Agendamento não encontrado/);
  await assert.rejects(() => scheduler.runScheduleCycle({ scheduleId: 1, scheduledFor: "invalido", dryRun: true, requireEnabled: false }), /scheduledFor inválido/);
});

test("ciclo controlado SELECTED não inclui outros computadores", async () => {
  const { scheduler, state } = makeCycleScheduler({
    computers: [
      { id: 15, hostname: "Anderson", deviceId: "anderson", status: "online", agentVersion: "1.1.14-dev" },
      { id: 107, hostname: "DESKTOP-1CD8JTL", deviceId: "desktop", status: "online", agentVersion: "1.1.15-dev" },
      { id: 1, hostname: "henrique", deviceId: "henrique", status: "online", agentVersion: "1.1.10" }
    ]
  });
  const result = await scheduler.runScheduleCycle({ scheduleId: 1, scheduledFor: "2026-09-03T23:00:00Z", dryRun: true, requireEnabled: false });
  assert.deepEqual(result.machines.map((machine) => machine.id), [15]);
  assert.deepEqual(state.actions, []);
});

test("unicidade do ciclo impede segundo dispatch após reinício do scheduler", async () => {
  const previous = process.env.MAINTENANCE_SCHEDULER_DRY_RUN;
  process.env.MAINTENANCE_SCHEDULER_DRY_RUN = "false";
  let runCreates = 0;
  let dispatches = 0;
  const schedule = { ...baseSchedule, targets: [] };
  const db = {
    maintenanceSchedule: {
      findMany: async () => [schedule],
      findUnique: async () => schedule
    },
    computador: { findMany: async () => [{ id: 1, hostname: "PC-1", deviceId: "d1", status: "online", agentVersion: "1.1.14-dev" }] },
    acaoRemotaExecucao: { findMany: async () => [] },
    maintenanceScheduleRun: {
      create: async () => {
        runCreates += 1;
        if (runCreates > 1) {
          const error = new Error("ciclo duplicado");
          error.code = "P2002";
          throw error;
        }
        return { id: 7 };
      },
      update: async ({ data }) => ({ id: 7, ...data })
    }
  };
  const scheduler = createMaintenanceScheduler({
    db,
    remoteActions: {
      createExecution: async () => ({ actionExecutionId: "scheduled-1", action: "system_maintenance" }),
      markDispatched: async () => true,
      markRejected: async () => true
    },
    ws: { sendToAgent: () => { dispatches += 1; return true; } },
    log: () => {}
  });
  const now = new Date("2026-09-03T20:00:30-03:00");
  try {
    await scheduler.tick(now);
    await scheduler.tick(now);
  } finally {
    if (previous === undefined) delete process.env.MAINTENANCE_SCHEDULER_DRY_RUN;
    else process.env.MAINTENANCE_SCHEDULER_DRY_RUN = previous;
  }
  assert.equal(runCreates, 2);
  assert.equal(dispatches, 1);
});
