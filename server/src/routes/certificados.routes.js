const express = require("express");
const { createCertificadosController } = require("../controllers/certificados.controller");
const { requireAdmin } = require("../auth/middleware");

function createCertificadosRouter({ syncService, releaseService } = {}) {
const controller = createCertificadosController({ syncService, releaseService });
const router = express.Router();

router.post("/sincronizar", requireAdmin(), controller.sincronizar);
router.get("/sincronizacoes", requireAdmin(), controller.sincronizacoes);
router.get("/sincronizacao-atual", requireAdmin(), controller.sincronizacaoAtual);
router.get("/storage-status", requireAdmin(), controller.storageStatus);
router.get("/source-diagnostic", requireAdmin(), controller.sourceDiagnostic);
router.get("/", requireAdmin(), controller.listar);
router.get("/:id", requireAdmin(), controller.obter);

return router;
}

module.exports = createCertificadosRouter();
module.exports.createCertificadosRouter = createCertificadosRouter;
