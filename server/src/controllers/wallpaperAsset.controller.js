const wallpaperAsset = require("../services/wallpaperAsset.service");

function createWallpaperAssetController({ service = wallpaperAsset, readFile = require("fs").createReadStream } = {}) {
  function download(req, res) {
    const result = service.consumeDownloadToken({
      token: req.query && req.query.token,
      actionExecutionId: req.query && req.query.actionExecutionId,
      deviceId: req.get("x-monitor-device-id"),
      assetId: req.query && req.query.assetId
    });
    if (!result.ok) return res.status(403).json({ erro: result.error });
    res.set("Content-Type", "image/jpeg");
    res.set("Content-Length", String(result.asset.size));
    return readFile(result.asset.path).on("error", () => res.status(500).end()).pipe(res);
  }
  return { download };
}

module.exports = { ...createWallpaperAssetController(), createWallpaperAssetController };
