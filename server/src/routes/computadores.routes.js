const express = require("express");
const router = express.Router();
const computadoresController = require("../controllers/computadores.controller");

router.get("/", computadoresController.list);
router.get("/:id", computadoresController.getById);

module.exports = router;
