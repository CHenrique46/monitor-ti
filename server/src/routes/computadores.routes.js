const express = require("express");
const router = express.Router();
const computadoresController = require("../controllers/computadores.controller");
const agentUpdateController = require("../controllers/agentUpdate.controller");

router.get("/", computadoresController.list);
router.delete("/:id", computadoresController.deleteComputer);
router.get("/:id", computadoresController.getById);
router.get("/:id/capabilities", computadoresController.getCapabilities);
router.post("/:id/agent-update", agentUpdateController.trigger);
router.get("/:id/agent-update", agentUpdateController.status);

module.exports = router;
