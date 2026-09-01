const express = require("express");
const router = express.Router();
const controller = require("../controllers/remoteActions.controller");

router.get("/:id/actions", controller.list);
router.post("/:id/actions/spooler-reset", controller.spoolerReset);
router.post("/:id/actions/service-restart", controller.serviceRestart);
router.post("/:id/actions/system-maintenance", controller.systemMaintenance);
router.post("/:id/actions/set-wallpaper", controller.setWallpaper);

module.exports = router;
