const metricasService = require("../services/metricas.service");

async function getByComputador(req, res) {
  try {
    const pontos = await metricasService.getMetricas(req.params.id, req.query.periodo);
    return res.status(200).json(pontos);
  } catch (err) {
    return res.status(500).json({ status: "error", message: err.message });
  }
}

module.exports = { getByComputador };
