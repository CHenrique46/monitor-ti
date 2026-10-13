const computadoresService = require("../services/computadores.service");
const { logEvent } = require("../logger");

function createComputadoresController({ service = computadoresService.createComputadoresService() } = {}) {
  async function deleteComputer(req, res) {
    try {
      const result = await service.deleteOfflineComputer(req.params.id);
      return res.status(200).json({ ok: true, computadorId: result.id });
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      if (err && ["ONLINE", "MAINTENANCE", "ARCHIVED"].includes(err.code)) return res.status(409).json({ erro: err.message });
      return res.status(500).json({ erro: "Não foi possível excluir o computador." });
    }
  }

  async function updateInventoryMetadata(req, res) {
    try {
      const before = service.getById ? await service.getById(req.params.id) : null;
      const item = await service.updateInventoryMetadata(req.params.id, req.body);
      if (before) {
        const changes = [
          ["equipamentoNumero", before.equipamentoNumero, item.equipamentoNumero],
          ["responsavel", before.apelido || before.usuario, item.apelido || item.usuario]
        ].filter(([, oldValue, newValue]) => oldValue !== newValue);
        for (const [field, oldValue, newValue] of changes) {
          logEvent(`[Monitor TI] inventory_admin_update computerId=${item.id} field=${field} old=${JSON.stringify(oldValue ?? null)} new=${JSON.stringify(newValue ?? null)} actor=${JSON.stringify(req.humanUser?.username || "unknown")} role=${req.humanUser?.role || "unknown"}`);
        }
      }
      return res.status(200).json(item);
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      if (err && err.code === "INVALID_METADATA") return res.status(400).json({ erro: err.message });
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      if (err && err.code === "DUPLICATE_EQUIPMENT") return res.status(409).json({ erro: err.message });
      if (err && err.code === "ARCHIVED") return res.status(409).json({ erro: err.message });
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

  async function addInventoryBaseline(req, res) {
    try {
      const result = await service.addInventoryBaseline(req.params.id, req.body);
      return res.status(201).json(result);
    } catch (err) {
      if (err && err.code === "INVALID_ID") return res.status(400).json({ erro: err.message });
      if (err && ["INVALID_REQUEST", "INVALID_EQUIPMENT"].includes(err.code)) return res.status(400).json({ erro: err.message });
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      if (err && ["BASELINE_EXISTS", "DUPLICATE_EQUIPMENT", "CONFLICT", "SNAPSHOT_INSUFFICIENT"].includes(err.code)) return res.status(409).json({ erro: err.message });
      if (err && err.code === "ARCHIVED") return res.status(409).json({ erro: err.message });
      return res.status(500).json({ erro: "Não foi possível adicionar o computador ao inventário." });
    }
  }

  async function listArchived(req, res) {
    try { return res.status(200).json(await service.listArchived()); }
    catch (err) { return res.status(500).json({ erro: err.message }); }
  }

  async function getByIdAdmin(req, res) {
    try {
      const item = await service.getByIdAdmin(req.params.id);
      return item ? res.status(200).json(item) : res.status(404).json({ erro: "Computador não encontrado" });
    } catch (err) { return res.status(500).json({ erro: err.message }); }
  }

  async function archive(req, res) {
    try { return res.status(200).json(await service.archiveComputer(req.params.id)); }
    catch (err) {
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      return res.status(400).json({ erro: err.message });
    }
  }

  async function restore(req, res) {
    try { return res.status(200).json(await service.restoreComputer(req.params.id)); }
    catch (err) {
      if (err && err.code === "NOT_FOUND") return res.status(404).json({ erro: err.message });
      return res.status(400).json({ erro: err.message });
    }
  }

  return {
    deleteComputer,
    listArchived,
    getByIdAdmin,
    archive,
    restore,
    listInventory: (req, res) => listInventoryWithService(req, res, service),
    updateInventoryMetadata,
    getInventoryComparison,
    addInventoryBaseline,
   list: (req, res) => listWithService(req, res, service),
   getById: (req, res) => getByIdWithService(req, res, service)
 };
}

async function listInventoryWithService(req, res, service) {
  try {
    return res.status(200).json(await service.listInventory());
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
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

module.exports = { list, getById, getCapabilities, listInventory: (req, res) => listInventoryWithService(req, res, computadoresService), updateInventoryMetadata: createComputadoresController().updateInventoryMetadata, getInventoryComparison: createComputadoresController().getInventoryComparison, addInventoryBaseline: createComputadoresController().addInventoryBaseline, deleteComputer: createComputadoresController().deleteComputer, listArchived: createComputadoresController().listArchived, getByIdAdmin: createComputadoresController().getByIdAdmin, archive: createComputadoresController().archive, restore: createComputadoresController().restore, createComputadoresController };
