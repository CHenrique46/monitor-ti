const scheduler = require("../services/maintenanceScheduler.service");

function createMaintenanceSchedulerController(service = scheduler) {
  async function list(req, res) {
    try { return res.status(200).json(await service.listSchedules()); }
    catch (error) { return res.status(500).json({ erro: error.message }); }
  }

  async function create(req, res) {
    try { return res.status(201).json(await service.createSchedule(req.body || {})); }
    catch (error) { return res.status(400).json({ erro: error.message }); }
  }

  async function update(req, res) {
    try {
      const result = await service.updateSchedule(Number(req.params.id), req.body || {});
      return result ? res.status(200).json(result) : res.status(404).json({ erro: "Agendamento não encontrado." });
    } catch (error) { return res.status(400).json({ erro: error.message }); }
  }

  async function runs(req, res) {
    try { return res.status(200).json(await service.listRuns(Number(req.params.id))); }
    catch (error) { return res.status(500).json({ erro: error.message }); }
  }

  async function dryRun(req, res) {
    try {
      const result = await service.dryRunSchedule(Number(req.params.id));
      return result ? res.status(200).json(result) : res.status(404).json({ erro: "Agendamento não encontrado." });
    } catch (error) { return res.status(400).json({ erro: error.message }); }
  }

  return { list, create, update, runs, dryRun };
}

module.exports = { ...createMaintenanceSchedulerController(), createMaintenanceSchedulerController };
