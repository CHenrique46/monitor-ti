const express = require("express");
const router = express.Router();
const controller = require("../controllers/avisos.controller");

router.post("/", controller.criar);
router.get("/", controller.listar);
router.get("/agendamentos", controller.listarAgendamentos);
router.put("/agendamentos/:id", controller.atualizarAgendamento);
router.delete("/agendamentos/:id", controller.excluirAgendamento);
router.get("/entregas", controller.historico);
router.post("/:id/enviar", controller.enviarAgora);

module.exports = router;
