const computadoresService = require("../services/computadores.service");

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

module.exports = { list, getById };
