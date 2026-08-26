const express = require("express");
const router = express.Router();
const controller = require("../controllers/agentRelease.controller");

// Ordem importa: /releases/latest antes de /releases/:version
router.get("/releases/latest", controller.latest);
router.get("/releases/:version", controller.getVersion);
router.get("/releases/:version/download", controller.download);
router.get("/releases/:version/package", controller.downloadPackage);

module.exports = router;
