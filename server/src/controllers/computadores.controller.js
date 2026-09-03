const computadoresService = require("../services/computadores.service");

function createComputadoresController({ service = computadoresService.createComputadoresService() } = {}) {
  async function deleteComputer(req, res) {
    try {
      const result = await service.deleteOfflineComputer(req.params.id);
      return res.status(200).json({ ok: true, computadorId: result.id });
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      if (err && ["ONLINE", "MAINTENANCE"].includes(err.code)) return res.status(409).json({ erro: err.message });
      return res.status(500).json({ erro: "Não foi possível excluir o computador." });
    }
  }

  async function updateInventoryMetadata(req, res) {
    try {
      const item = await service.updateInventoryMetadata(req.params.id, req.body);
      return res.status(200).json(item);
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      if (err && err.code === "INVALID_METADATA") return res.status(400).json({ erro: err.message });
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      if (err && err.code === "DUPLICATE_EQUIPMENT") return res.status(409).json({ erro: err.message });
      return res.status(500).json({ erro: "Não foi possível atualizar a identificação." });
    }
  }

  async function getInventoryComparison(req, res) {
    try {
      const result = await service.getInventoryComparison(req.params.id);
      if (!result) return res.status(404).json({ erro: "Computador não encontrado." });
      return res.status(200).json(result);
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      return res.status(500).json({ erro: "Não foi possível comparar o inventário." });
    }
  }

 return {
    deleteComputer,
    updateInventoryMetadata,
    getInventoryComparison,
   list: (req, res) => listWithService(req, res, service),
   getById: (req, res) => getByIdWithService(req, res, service)
 };
}

async function list(req, res) {
  return listWithService(req, res, computadoresService);
}

async function listWithService(req, res, service) {
  try {
    const items = await service.list();
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

async function getById(req, res) {
  return getByIdWithService(req, res, computadoresService);
}

async function getByIdWithService(req, res, service) {
  try {
    const item = await service.getById(req.params.id);
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

module.exports = { list, getById, getCapabilities, updateInventoryMetadata: createComputadoresController().updateInventoryMetadata, getInventoryComparison: createComputadoresController().getInventoryComparison, deleteComputer: createComputadoresController().deleteComputer, createComputadoresController };
