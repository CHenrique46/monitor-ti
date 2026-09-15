const express = require("express");
const { createCertificadosController } = require("../controllers/certificados.controller");
const { requireAdmin } = require("../auth/middleware");

function createCertificadosRouter({ syncService } = {}) {
const controller = createCertificadosController({ syncService });
const router = express.Router();

router.post("/sincronizar", requireAdmin(), controller.sincronizar);
router.get("/sincronizacoes", requireAdmin(), controller.sincronizacoes);
router.get("/sincronizacao-atual", requireAdmin(), controller.sincronizacaoAtual);
router.get("/", requireAdmin(), controller.listar);
router.get("/:id", requireAdmin(), controller.obter);

return router;
}

module.exports = createCertificadosRouter();
module.exports.createCertificadosRouter = createCertificadosRouter;
