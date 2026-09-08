const express = require("express");
const router = express.Router();
const computadoresController = require("../controllers/computadores.controller");
const agentUpdateController = require("../controllers/agentUpdate.controller");
const { requireAdmin } = require("../auth/middleware");

router.get("/", computadoresController.list);
router.delete("/:id", requireAdmin(), computadoresController.deleteComputer);
router.get("/:id", computadoresController.getById);
router.get("/:id/capabilities", computadoresController.getCapabilities);
router.patch("/:id/inventory-metadata", requireAdmin(), computadoresController.updateInventoryMetadata);
router.get("/:id/inventory-comparison", computadoresController.getInventoryComparison);
router.post("/:id/inventory-baseline", requireAdmin(), computadoresController.addInventoryBaseline);
router.post("/:id/agent-update", requireAdmin(), agentUpdateController.trigger);
router.get("/:id/agent-update", agentUpdateController.status);

module.exports = router;
