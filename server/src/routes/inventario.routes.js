const express = require("express");
const computadoresController = require("../controllers/computadores.controller");

const router = express.Router();

router.get("/", computadoresController.listInventory);

module.exports = router;
