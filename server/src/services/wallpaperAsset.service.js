const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ASSET_ID = "official-wallpaper-v1";
const ASSET_FILENAME = "WallPaperVava.jpg";
const ASSET_PATH = "C:\\DskBackground\\WallPaperVava.jpg";
const ASSET_EXTENSION = ".jpg";
const MAX_ASSET_SIZE = 10 * 1024 * 1024;
const TOKEN_TTL_MS = 5 * 60 * 1000;

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function readOfficialAsset({ assetPath = ASSET_PATH, readFileImpl = fs.readFileSync } = {}) {
  if (!assetPath || path.extname(assetPath).toLowerCase() !== ASSET_EXTENSION) {
    throw new Error("Asset oficial deve ser JPG.");
  }
  let buffer;
  try { buffer = (readFileImpl || fs.readFileSync)(assetPath); } catch { throw new Error("Asset oficial não encontrado."); }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_ASSET_SIZE) {
    throw new Error("Tamanho do asset oficial inválido.");
  }
  if (!isJpeg(buffer)) throw new Error("Formato do asset oficial inválido.");
  return {
    assetId: ASSET_ID,
    filename: ASSET_FILENAME,
    extension: ASSET_EXTENSION,
    size: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase(),
    path: assetPath,
    buffer
  };
}

function createWallpaperAssetService({ assetPath = ASSET_PATH, now = () => Date.now(), randomBytes = crypto.randomBytes, readFileImpl } = {}) {
  const tokens = new Map();

  function issueDownloadToken({ actionExecutionId, deviceId }) {
    const asset = readOfficialAsset({ assetPath, readFileImpl });
    const token = randomBytes(32).toString("base64url");
    tokens.set(crypto.createHash("sha256").update(token).digest("hex"), {
      actionExecutionId: String(actionExecutionId),
      deviceId: String(deviceId),
      assetId: asset.assetId,
      expectedSha256: asset.sha256,
      expectedSize: asset.size,
      expiresAt: now() + TOKEN_TTL_MS
    });
    return { token, expiresAt: now() + TOKEN_TTL_MS, asset: { ...asset, buffer: undefined } };
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
    let asset;
    try { asset = readOfficialAsset({ assetPath, readFileImpl }); } catch (error) {
      return { ok: false, status: 409, error: error.message };
    }
    if (asset.sha256 !== record.expectedSha256 || asset.size !== record.expectedSize) {
      tokens.delete(key);
      return { ok: false, status: 409, error: "Asset oficial foi alterado após a criação da ação." };
    }
    tokens.delete(key);
    return { ok: true, asset };
  }

  return { issueDownloadToken, consumeDownloadToken, validate: () => readOfficialAsset({ assetPath, readFileImpl }), clear: () => tokens.clear() };
}

const defaultService = createWallpaperAssetService();

module.exports = {
  ASSET_ID, ASSET_FILENAME, ASSET_PATH, ASSET_EXTENSION, MAX_ASSET_SIZE, TOKEN_TTL_MS,
  isJpeg, readOfficialAsset, createWallpaperAssetService, ...defaultService
};
