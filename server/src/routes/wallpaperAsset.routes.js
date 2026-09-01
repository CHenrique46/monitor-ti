const express = require("express");
const controller = require("../controllers/wallpaperAsset.controller");
const router = express.Router();

router.get("/wallpaper/current", controller.download);

module.exports = router;
