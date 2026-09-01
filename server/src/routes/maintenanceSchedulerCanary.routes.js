const express = require("express");
const scheduler = require("../services/maintenanceScheduler.service");

const ALLOWED_FIELDS = new Set(["scheduleId", "scheduledFor", "dryRun"]);

function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase();
  if (value === "127.0.0.1" || value === "::1") return true;
  return value.startsWith("::ffff:") && value.slice(7) === "127.0.0.1";
}

function createMaintenanceSchedulerCanaryRouter({ schedulerService = scheduler, env = process.env, getRemoteAddress = (req) => req.socket && req.socket.remoteAddress } = {}) {
  const router = express.Router();

  router.post("/", async (req, res) => {
    if (String(env.MAINTENANCE_SCHEDULER_CANARY_ENABLED).toLowerCase() !== "true") {
      return res.status(404).json({ erro: "Canário do scheduler desabilitado." });
    }
    if (!isLoopbackAddress(getRemoteAddress(req))) {
      return res.status(403).json({ erro: "Canário do scheduler aceita somente loopback." });
    }

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((field) => !ALLOWED_FIELDS.has(field))) {
      return res.status(400).json({ erro: "Body do canário contém campos não permitidos." });
    }
    if (!Number.isInteger(Number(body.scheduleId)) || Number(body.scheduleId) <= 0 || typeof body.scheduledFor !== "string" || !body.scheduledFor || Number.isNaN(new Date(body.scheduledFor).getTime()) || typeof body.dryRun !== "boolean") {
      return res.status(400).json({ erro: "scheduleId, scheduledFor e dryRun são obrigatórios e inválidos." });
    }

    try {
      const schedule = await schedulerService.getSchedule(Number(body.scheduleId));
      if (!schedule) return res.status(404).json({ erro: "Agendamento não encontrado." });
      if (schedule.enabled !== false || schedule.targetMode !== "SELECTED" || !Array.isArray(schedule.targets) || schedule.targets.length !== 1) {
        return res.status(409).json({ erro: "Canário exige policy desabilitada, SELECTED e exatamente um target." });
      }

      const result = await schedulerService.runScheduleCycle({
        scheduleId: Number(body.scheduleId),
        scheduledFor: body.scheduledFor,
        dryRun: body.dryRun,
        requireEnabled: false
      });
      return res.status(200).json(result);
    } catch (error) {
      return res.status(400).json({ erro: error.message });
    }
  });

  return router;
}

module.exports = createMaintenanceSchedulerCanaryRouter();
module.exports.createMaintenanceSchedulerCanaryRouter = createMaintenanceSchedulerCanaryRouter;
module.exports.isLoopbackAddress = isLoopbackAddress;
