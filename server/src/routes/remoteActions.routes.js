const express = require("express");
const router = express.Router();
const controller = require("../controllers/remoteActions.controller");
const { requireAdmin } = require("../auth/middleware");

router.get("/:id/actions", controller.list);
router.post("/:id/actions/spooler-reset", requireAdmin(), controller.spoolerReset);
router.post("/:id/actions/service-restart", requireAdmin(), controller.serviceRestart);
router.post("/:id/actions/system-maintenance", requireAdmin(), controller.systemMaintenance);
router.post("/:id/actions/set-wallpaper", requireAdmin(), controller.setWallpaper);

module.exports = router;
