const express = require("express");
const router = express.Router();
const alertasController = require("../controllers/alertas.controller");

router.get("/", alertasController.list);
router.get("/:id/alertas", alertasController.listByComputador);

module.exports = router;
