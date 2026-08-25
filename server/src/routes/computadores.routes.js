const express = require("express");
const router = express.Router();
const computadoresController = require("../controllers/computadores.controller");

router.get("/", computadoresController.list);

module.exports = router;
