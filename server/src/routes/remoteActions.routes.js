const express = require("express");
const router = express.Router();
const controller = require("../controllers/remoteActions.controller");

router.get("/:id/actions", controller.list);
router.post("/:id/actions/spooler-reset", controller.spoolerReset);

module.exports = router;
