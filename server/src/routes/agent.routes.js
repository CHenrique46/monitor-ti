const express = require("express");
const controller = require("../controllers/agentRelease.controller");
const { requireHumanSession, requireAdmin } = require("../auth/middleware");

function createAgentRouter({ authService, releaseController = controller } = {}) {
  const router = express.Router();
  const adminSession = [requireHumanSession(authService), requireAdmin()];

  // Ordem importa: /releases/latest antes de /releases/:version.
  router.get("/releases", ...adminSession, releaseController.list);
  router.get("/releases/latest", controller.latest);
  router.get("/releases/:version", controller.getVersion);
  router.get("/releases/:version/download", controller.download);
  router.get("/releases/:version/package", controller.downloadPackage);

  return router;
}

module.exports = { createAgentRouter };
