const computadoresService = require("../services/computadores.service");

function createComputadoresController({ service = computadoresService } = {}) {
async function deleteComputer(req, res) {
  try {
    const result = await service.deleteOfflineComputer(req.params.id);
    return res.status(200).json({ ok: true, computadorId: result.id });
  } catch (err) {
    if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
    if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
    if (err && ["ONLINE", "MAINTENANCE"].includes(err.code)) {
      return res.status(409).json({ erro: err.message });
    }
    return res.status(500).json({ erro: "Não foi possível excluir o computador." });
  }
}

return { deleteComputer };
}

async function list(req, res) {
  try {
    const items = await computadoresService.list();
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

async function getById(req, res) {
  try {
    const item = await computadoresService.getById(req.params.id);
    if (!item) {
      return res.status(404).json({ erro: "Computador não encontrado" });
    }
    return res.status(200).json(item);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

async function getCapabilities(req, res) {
  try {
    const item = await computadoresService.getCapabilitiesById(req.params.id);
    if (!item) {
      return res.status(404).json({ erro: "Computador não encontrado" });
    }
    return res.status(200).json(item);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

module.exports = { list, getById, getCapabilities, deleteComputer: createComputadoresController().deleteComputer, createComputadoresController };
