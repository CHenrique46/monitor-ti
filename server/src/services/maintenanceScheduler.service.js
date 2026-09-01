const prisma = require("../prisma");
const remoteActionsService = require("./remoteActions.service");
const { refreshScheduleRun } = require("./remoteActions.service");
const agentServer = require("../ws/agentServer");
const { logEvent } = require("../logger");

const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const DEFAULT_NAME = "Manutenção preventiva semanal";
const DEFAULT_DAY_OF_WEEK = 4;
const DEFAULT_TIME = "20:00";
const DEFAULT_TARGET_MODE = "ALL";
const SCHEDULE_RUN_STATUSES = new Set(["PLANNED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED"]);
const INTERVAL_MS = 60_000;
const DUE_WINDOW_MS = 60_000;

function parseTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch (err) {
    throw new Error("Timezone inválida.");
  }
  return timezone;
}

function validateScheduleInput(input = {}, { partial = false } = {}) {
  const value = {};
  if (!partial || input.name !== undefined) {
    value.name = String(input.name || "").trim();
    if (!value.name || value.name.length > 120) throw new Error("Nome do agendamento inválido.");
  }
  if (!partial || input.dayOfWeek !== undefined) {
    value.dayOfWeek = Number(input.dayOfWeek);
    if (!Number.isInteger(value.dayOfWeek) || value.dayOfWeek < 0 || value.dayOfWeek > 6) {
      throw new Error("Dia da semana inválido.");
    }
  }
  if (!partial || input.time !== undefined) {
    value.time = String(input.time || "");
    if (!parseTime(value.time)) throw new Error("Horário inválido.");
  }
  if (!partial || input.timezone !== undefined) {
    value.timezone = assertTimezone(String(input.timezone || ""));
  }
  if (!partial || input.targetMode !== undefined) {
    value.targetMode = String(input.targetMode || "").trim().toUpperCase();
    if (!["ALL", "SELECTED"].includes(value.targetMode)) throw new Error("Modo de alvo inválido.");
  }
  if (!partial || input.enabled !== undefined) {
    value.enabled = input.enabled === true;
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new Error("enabled inválido.");
  }
  if (input.computerIds !== undefined) {
    if (!Array.isArray(input.computerIds) || input.computerIds.some((id) => !Number.isInteger(Number(id)))) {
      throw new Error("computerIds inválido.");
    }
    value.computerIds = Array.from(new Set(input.computerIds.map(Number)));
  }
  return value;
}

function getZonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = Number(part.value);
    return result;
  }, {});
  return parts;
}

function getTimeZoneOffsetMs(date, timezone) {
  const parts = getZonedParts(date, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - date.getTime();
}

function wallTimeToDate(wall, timezone) {
  const wallUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  let result = new Date(wallUtc - getTimeZoneOffsetMs(new Date(wallUtc), timezone));
  result = new Date(wallUtc - getTimeZoneOffsetMs(result, timezone));
  return result;
}

function addDays(year, month, day, amount) {
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function wallCompare(left, right) {
  return Date.UTC(left.year, left.month - 1, left.day, left.hour, left.minute) -
    Date.UTC(right.year, right.month - 1, right.day, right.hour, right.minute);
}

function calculateNextExecution(schedule, now = new Date()) {
  const time = parseTime(schedule.time);
  if (!time) throw new Error("Horário inválido.");
  assertTimezone(schedule.timezone);
  const current = getZonedParts(now, schedule.timezone);
  const currentDate = { year: current.year, month: current.month, day: current.day };
  const currentDay = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
  let daysUntil = (Number(schedule.dayOfWeek) - currentDay + 7) % 7;
  let candidateDate = addDays(current.year, current.month, current.day, daysUntil);
  let candidateWall = { ...candidateDate, hour: time.hour, minute: time.minute };
  const currentWall = { ...currentDate, hour: current.hour, minute: current.minute };
  if (daysUntil === 0 && wallCompare(candidateWall, currentWall) <= 0) {
    daysUntil = 7;
    candidateDate = addDays(current.year, current.month, current.day, daysUntil);
    candidateWall = { ...candidateDate, hour: time.hour, minute: time.minute };
  }
  return wallTimeToDate(candidateWall, schedule.timezone);
}

function getDueExecution(schedule, now = new Date()) {
  const time = parseTime(schedule.time);
  if (!time) return null;
  const current = getZonedParts(now, schedule.timezone);
  const currentDay = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
  if (currentDay !== Number(schedule.dayOfWeek)) return null;
  const occurrence = wallTimeToDate({ year: current.year, month: current.month, day: current.day, hour: time.hour, minute: time.minute }, schedule.timezone);
  const diff = now.getTime() - occurrence.getTime();
  return diff >= 0 && diff <= DUE_WINDOW_MS ? occurrence : null;
}

function parseScheduledFor(value) {
  if (!(value instanceof Date) && typeof value !== "string") {
    throw new Error("scheduledFor obrigatório.");
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("scheduledFor inválido.");
  return date;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || ""));
  return match ? match.slice(1).map(Number) : null;
}

function isCompatibleAgent(value) {
  const version = parseVersion(value);
  return !!version && (version[0] > 1 || (version[0] === 1 && version[1] >= 1));
}

function mapSchedule(schedule) {
  if (!schedule) return null;
  return {
    id: schedule.id,
    enabled: schedule.enabled,
    name: schedule.name,
    dayOfWeek: schedule.dayOfWeek,
    time: schedule.time,
    timezone: schedule.timezone,
    targetMode: schedule.targetMode,
    computerIds: (schedule.targets || []).map((target) => target.computadorId),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextExecution: calculateNextExecution(schedule).toISOString(),
    lastRun: schedule.runs && schedule.runs[0] ? mapRun(schedule.runs[0]) : null
  };
}

function mapRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    scheduleId: run.scheduleId,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    status: run.status,
    targetCount: run.targetCount,
    dispatchedCount: run.dispatchedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount
  };
}

function createMaintenanceScheduler({ db = prisma, remoteActions = remoteActionsService, ws = agentServer, log = logEvent } = {}) {
  let timer = null;
  const dryRun = String(process.env.MAINTENANCE_SCHEDULER_DRY_RUN || "true").toLowerCase() !== "false";

  async function getSchedule(id) {
    return db.maintenanceSchedule.findUnique({
      where: { id: Number(id) },
      include: { targets: true, runs: { orderBy: { scheduledFor: "desc" }, take: 1 } }
    });
  }

  async function listSchedules() {
    const schedules = await db.maintenanceSchedule.findMany({
      include: { targets: true, runs: { orderBy: { scheduledFor: "desc" }, take: 1 } },
      orderBy: { id: "asc" }
    });
    return schedules.map(mapSchedule);
  }

  async function validateComputerIds(ids) {
    const uniqueIds = Array.from(new Set((ids || []).map(Number)));
    if (!uniqueIds.length) return [];
    const found = await db.computador.findMany({ where: { id: { in: uniqueIds } }, select: { id: true } });
    if (found.length !== uniqueIds.length) throw new Error("Um ou mais computadores não existem.");
    return uniqueIds;
  }

  async function createSchedule(input) {
    const value = validateScheduleInput(input);
    const computerIds = await validateComputerIds(value.computerIds || []);
    if (value.targetMode === "SELECTED" && !computerIds.length) throw new Error("Selecione ao menos um computador.");
    const data = {
      enabled: value.enabled === true,
      name: value.name,
      dayOfWeek: value.dayOfWeek,
      time: value.time,
      timezone: value.timezone,
      targetMode: value.targetMode
    };
    const created = await db.$transaction(async (tx) => {
      const schedule = await tx.maintenanceSchedule.create({ data });
      if (computerIds.length) {
        await tx.maintenanceScheduleTarget.createMany({ data: computerIds.map((computadorId) => ({ scheduleId: schedule.id, computadorId })) });
      }
      return schedule;
    });
    return mapSchedule(await getSchedule(created.id));
  }

  async function updateSchedule(id, input) {
    const value = validateScheduleInput(input, { partial: true });
    const existing = await getSchedule(id);
    if (!existing) return null;
    const computerIds = input.computerIds === undefined
      ? existing.targets.map((target) => target.computadorId)
      : await validateComputerIds(value.computerIds);
    const targetMode = value.targetMode || existing.targetMode;
    if (targetMode === "SELECTED" && !computerIds.length) throw new Error("Selecione ao menos um computador.");
    const data = { ...value };
    delete data.computerIds;
    const updated = await db.$transaction(async (tx) => {
      const schedule = await tx.maintenanceSchedule.update({ where: { id: Number(id) }, data });
      await tx.maintenanceScheduleTarget.deleteMany({ where: { scheduleId: Number(id) } });
      if (computerIds.length) {
        await tx.maintenanceScheduleTarget.createMany({ data: computerIds.map((computadorId) => ({ scheduleId: Number(id), computadorId })) });
      }
      return schedule;
    });
    return mapSchedule(await getSchedule(updated.id));
  }

  async function listRuns(id) {
    const runs = await db.maintenanceScheduleRun.findMany({ where: { scheduleId: Number(id) }, orderBy: { scheduledFor: "desc" }, take: 100 });
    return runs.map(mapRun);
  }

  async function buildPlan(schedule, now = new Date()) {
    const ids = schedule.targetMode === "SELECTED" ? schedule.targets.map((target) => target.computadorId) : null;
    const computers = await db.computador.findMany({
      where: ids ? { id: { in: ids } } : {},
      select: { id: true, hostname: true, deviceId: true, status: true, agentVersion: true }
    });
    const inProgress = computers.length
      ? await db.acaoRemotaExecucao.findMany({
        where: { computadorId: { in: computers.map((computer) => computer.id) }, action: "system_maintenance", status: { in: ["PENDING", "DISPATCHED", "RUNNING"] } },
        select: { computadorId: true }
      })
      : [];
    const busy = new Set(inProgress.map((item) => item.computadorId));
    const machines = computers.map((computer) => {
      let reason = null;
      if (computer.status !== "online") reason = "offline";
      else if (!isCompatibleAgent(computer.agentVersion)) reason = "incompatible_agent";
      else if (busy.has(computer.id)) reason = "action_in_progress";
      return { ...computer, eligible: !reason, reason };
    });
    const nextExecution = calculateNextExecution(schedule, now);
    return {
      mode: "DRY_RUN",
      scheduleId: schedule.id,
      scheduledFor: nextExecution.toISOString(),
      targetCount: machines.length,
      eligibleCount: machines.filter((machine) => machine.eligible).length,
      offlineCount: machines.filter((machine) => machine.reason === "offline").length,
      inProgressCount: machines.filter((machine) => machine.reason === "action_in_progress").length,
      incompatibleAgentCount: machines.filter((machine) => machine.reason === "incompatible_agent").length,
      alreadyExecutedCount: 0,
      machines
    };
  }

  async function dryRunSchedule(id, now = new Date()) {
    const schedule = await getSchedule(id);
    if (!schedule) return null;
    return buildPlan(schedule, now);
  }

  async function ensureDefaultSchedule() {
    const count = await db.maintenanceSchedule.count();
    if (count > 0) return;
    await db.maintenanceSchedule.create({
      data: { enabled: false, name: DEFAULT_NAME, dayOfWeek: DEFAULT_DAY_OF_WEEK, time: DEFAULT_TIME, timezone: DEFAULT_TIMEZONE, targetMode: DEFAULT_TARGET_MODE }
    });
  }

  async function dispatchSchedule(schedule, scheduledFor) {
    let run;
    try {
      run = await db.maintenanceScheduleRun.create({ data: { scheduleId: schedule.id, scheduledFor, status: "RUNNING", startedAt: new Date() } });
    } catch (error) {
      if (error && error.code === "P2002") return { duplicate: true };
      throw error;
    }
    const plan = await buildPlan(schedule, new Date(scheduledFor));
    let dispatched = 0;
    let failed = 0;
    let skipped = plan.targetCount - plan.eligibleCount;
    for (const machine of plan.machines.filter((item) => item.eligible)) {
      try {
        const execution = await remoteActions.createExecution({ computadorId: machine.id, action: "system_maintenance", scheduleRunId: run.id });
        if (!ws.sendToAgent(machine.deviceId, { type: "remote_action", protocolVersion: 1, deviceId: machine.deviceId, actionExecutionId: execution.actionExecutionId, action: execution.action, payload: {} })) {
          await remoteActions.markRejected(execution.actionExecutionId, "Agent nao conectado no momento.", "Agent nao conectado no momento.");
          failed += 1;
        } else {
          await remoteActions.markDispatched(execution.actionExecutionId);
          dispatched += 1;
        }
      } catch (error) {
        failed += 1;
        log(`[Monitor TI] scheduler dispatch failed computadorId=${machine.id} erro=${error.message}`);
      }
    }
    await db.maintenanceScheduleRun.update({ where: { id: run.id }, data: { targetCount: plan.targetCount, skippedCount: skipped, failedCount: failed } });
    await refreshScheduleRun(db, run.id);
    return { duplicate: false, dispatched, failed, skipped };
  }

  async function runScheduleCycle({ scheduleId, scheduledFor, dryRun: cycleDryRun, requireEnabled = true } = {}) {
    if (!Number.isInteger(Number(scheduleId)) || Number(scheduleId) <= 0) {
      throw new Error("scheduleId inválido.");
    }
    if (typeof cycleDryRun !== "boolean") throw new Error("dryRun obrigatório.");
    const occurrence = parseScheduledFor(scheduledFor);
    const schedule = await getSchedule(Number(scheduleId));
    if (!schedule) throw new Error("Agendamento não encontrado.");
    if (requireEnabled && !schedule.enabled) return { ignored: true, reason: "disabled", scheduleId: schedule.id };

    if (cycleDryRun) {
      const plan = await buildPlan(schedule, occurrence);
      return { ...plan, scheduledFor: occurrence.toISOString() };
    }

    return {
      mode: "REAL",
      scheduleId: schedule.id,
      scheduledFor: occurrence.toISOString(),
      ...(await dispatchSchedule(schedule, occurrence))
    };
  }

  async function tick(now = new Date()) {
    const schedules = await db.maintenanceSchedule.findMany({ where: { enabled: true }, include: { targets: true, runs: { orderBy: { scheduledFor: "desc" }, take: 1 } } });
    for (const schedule of schedules) {
      const due = getDueExecution(schedule, now);
      if (!due) continue;
      const result = await runScheduleCycle({ scheduleId: schedule.id, scheduledFor: due, dryRun, requireEnabled: true });
      if (result.mode === "DRY_RUN") log(`[Monitor TI] scheduler dry-run scheduleId=${schedule.id} scheduledFor=${due.toISOString()}`);
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => tick().catch((error) => log(`[Monitor TI] scheduler error: ${error.message}`)), INTERVAL_MS);
    if (typeof timer.unref === "function") timer.unref();
    log(`[Monitor TI] scheduler iniciado intervaloMs=${INTERVAL_MS} dryRun=${dryRun}`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { listSchedules, getSchedule, createSchedule, updateSchedule, listRuns, dryRunSchedule, runScheduleCycle, ensureDefaultSchedule, tick, start, stop, calculateNextExecution, buildPlan };
}

const defaultScheduler = createMaintenanceScheduler();

module.exports = {
  DEFAULT_TIMEZONE,
  DEFAULT_NAME,
  DEFAULT_DAY_OF_WEEK,
  DEFAULT_TIME,
  DEFAULT_TARGET_MODE,
  SCHEDULE_RUN_STATUSES,
  INTERVAL_MS,
  parseTime,
  validateScheduleInput,
  calculateNextExecution,
  getDueExecution,
  isCompatibleAgent,
  createMaintenanceScheduler,
  ...defaultScheduler
};
