const express = require("express");
const controller = require("../controllers/certificados.controller");
const { requireAdmin } = require("../auth/middleware");

const router = express.Router();

router.post("/sincronizar", requireAdmin(), controller.sincronizar);
router.get("/", requireAdmin(), controller.listar);
router.get("/:id", requireAdmin(), controller.obter);

module.exports = router;
