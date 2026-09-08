const express = require("express");
const router = express.Router();
const controller = require("../controllers/avisos.controller");
const { requireAdmin } = require("../auth/middleware");

router.post("/", requireAdmin(), controller.criar);
router.get("/", controller.listar);
router.get("/agendamentos", controller.listarAgendamentos);
router.put("/agendamentos/:id", requireAdmin(), controller.atualizarAgendamento);
router.delete("/agendamentos/:id", requireAdmin(), controller.excluirAgendamento);
router.get("/entregas", controller.historico);
router.post("/:id/enviar", requireAdmin(), controller.enviarAgora);

module.exports = router;
