const alertasService = require("../services/alertas.service");

async function list(req, res) {
  try {
    // Padrao: apenas ativos (conforme Dashboard). ativos=false retorna todos.
    const ativos = req.query.ativos !== "false";
    const computadorId = req.query.computadorId;
    const items = await alertasService.listAlertas({
      ativos,
      computadorId: computadorId ? Number(computadorId) : undefined
    });
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

async function listByComputador(req, res) {
  try {
    const items = await alertasService.listAlertas({ computadorId: req.params.id });
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

module.exports = { list, listByComputador };
