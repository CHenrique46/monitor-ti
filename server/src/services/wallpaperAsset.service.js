const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ASSET_ID = "official-wallpaper-v1";
const ASSET_FILENAME = "WallPaperVava.jpg";
const ASSET_PATH = "C:\\DskBackground\\WallPaperVava.jpg";
const ASSET_EXTENSION = ".jpg";
const ASSET_SIZE = 174163;
const ASSET_SHA256 = "F5D2B5A264D60A9FC3FA8D130C0D9412411C98F753C10F2D0F441A4326CFE69E";
const MAX_ASSET_SIZE = 10 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60 * 1000;

function validateOfficialAsset({ statImpl = fs.statSync, hashImpl = null, assetPath = ASSET_PATH } = {}) {
  if (!assetPath || path.extname(assetPath).toLowerCase() !== ASSET_EXTENSION) {
    throw new Error("Asset oficial deve ser JPG.");
  }
  let stat;
  try { stat = (statImpl || fs.statSync)(assetPath); } catch { throw new Error("Asset oficial não encontrado."); }
  if (!stat.isFile() || stat.size > MAX_ASSET_SIZE || stat.size !== ASSET_SIZE) {
    throw new Error("Tamanho do asset oficial inválido.");
  }
  const digest = hashImpl ? hashImpl(assetPath) : crypto.createHash("sha256").update(fs.readFileSync(assetPath)).digest("hex").toUpperCase();
  if (String(digest).toUpperCase() !== ASSET_SHA256) throw new Error("Hash do asset oficial divergente.");
  return { assetId: ASSET_ID, filename: ASSET_FILENAME, extension: ASSET_EXTENSION, size: stat.size, sha256: ASSET_SHA256, path: assetPath };
}

function createWallpaperAssetService({ assetPath = ASSET_PATH, now = () => Date.now(), randomBytes = crypto.randomBytes, statImpl, hashImpl } = {}) {
  const tokens = new Map();

  function issueDownloadToken({ actionExecutionId, deviceId }) {
    const asset = validateOfficialAsset({ assetPath, statImpl, hashImpl });
    const token = randomBytes(32).toString("base64url");
    tokens.set(crypto.createHash("sha256").update(token).digest("hex"), {
      actionExecutionId: String(actionExecutionId), deviceId: String(deviceId), assetId: ASSET_ID, expiresAt: now() + TOKEN_TTL_MS
    });
    return { token, expiresAt: now() + TOKEN_TTL_MS, asset };
  }

  function consumeDownloadToken({ token, actionExecutionId, deviceId, assetId }) {
    if (!token) return { ok: false, status: 403, error: "Token inválido." };
    const key = crypto.createHash("sha256").update(String(token)).digest("hex");
    const record = tokens.get(key);
    if (!record || record.expiresAt <= now()) {
      if (record) tokens.delete(key);
      return { ok: false, status: 403, error: "Token expirado ou inválido." };
    }
    if (record.assetId !== ASSET_ID || String(assetId || "") !== ASSET_ID || record.actionExecutionId !== String(actionExecutionId) || record.deviceId !== String(deviceId)) {
      return { ok: false, status: 403, error: "Token não corresponde à ação." };
    }
    return { ok: true, asset: validateOfficialAsset({ assetPath, statImpl, hashImpl }) };
  }

  return { issueDownloadToken, consumeDownloadToken, validate: () => validateOfficialAsset({ assetPath, statImpl, hashImpl }), clear: () => tokens.clear() };
}

const defaultService = createWallpaperAssetService();

module.exports = {
  ASSET_ID, ASSET_FILENAME, ASSET_PATH, ASSET_EXTENSION, ASSET_SIZE, ASSET_SHA256, MAX_ASSET_SIZE, TOKEN_TTL_MS,
  validateOfficialAsset, createWallpaperAssetService, ...defaultService
};
