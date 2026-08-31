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

test("unicidade do ciclo impede segundo dispatch após reinício do scheduler", async () => {
  const previous = process.env.MAINTENANCE_SCHEDULER_DRY_RUN;
  process.env.MAINTENANCE_SCHEDULER_DRY_RUN = "false";
  let runCreates = 0;
  let dispatches = 0;
  const schedule = { ...baseSchedule, targets: [] };
  const db = {
    maintenanceSchedule: { findMany: async () => [schedule] },
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
