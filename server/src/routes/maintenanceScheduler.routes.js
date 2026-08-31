const express = require("express");
const controller = require("../controllers/maintenanceScheduler.controller");

const router = express.Router();
router.get("/", controller.list);
router.post("/", controller.create);
router.put("/:id", controller.update);
router.get("/:id/runs", controller.runs);
router.post("/:id/dry-run", controller.dryRun);

module.exports = router;
