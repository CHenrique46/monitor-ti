const express = require("express");
const router = express.Router();
const metricasController = require("../controllers/metricas.controller");

router.get("/:id/metricas", metricasController.getByComputador);

module.exports = router;
