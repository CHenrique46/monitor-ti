const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ASSET_ID = "official-wallpaper-v1";
const EXTENSION = ".jpg";
const MAX_SIZE = 10 * 1024 * 1024;

function serverHttpOrigin(serverUrl) {
  const raw = String(serverUrl || "").trim().replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  return new URL(raw).origin;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").toUpperCase()));
  });
}

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function createWallpaperExecutor(deps = {}) {
  const rootDir = deps.rootDir || path.join(process.env.ProgramData || "C:\\ProgramData", "MonitorTI", "wallpaper");
  const finalPath = path.join(rootDir, "WallPaperVava.jpg");
  const fetchImpl = deps.fetch || globalThis.fetch;
  const serverUrl = deps.serverUrl;
  const downloadTimeoutMs = deps.downloadTimeoutMs || 60000;
  const mkdir = deps.mkdir || fs.promises.mkdir;
  const stat = deps.stat || fs.promises.stat;
  const hash = deps.sha256File || sha256File;
  const readFile = deps.readFile || fs.promises.readFile;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const rename = deps.rename || fs.promises.rename;
  const unlink = deps.unlink || fs.promises.unlink;

  function getDownloadDeviceId() {
    if (typeof deps.getDeviceId !== "function") throw new Error("deviceId do Agent indisponível.");
    let deviceId;
    try { deviceId = deps.getDeviceId(); } catch { throw new Error("Não foi possível obter o deviceId do Agent."); }
    if (typeof deviceId !== "string" || !deviceId.trim()) throw new Error("deviceId do Agent inválido.");
    return deviceId.trim();
  }

  function validatePayload(payload) {
    const expectedSha256 = String(payload && payload.expectedSha256 || "").toUpperCase();
    const expectedSize = payload && payload.expectedSize;
    if (!payload || payload.assetId !== ASSET_ID || payload.extension !== EXTENSION || !/^[A-F0-9]{64}$/.test(expectedSha256) || !Number.isInteger(expectedSize) || expectedSize <= 0 || expectedSize > MAX_SIZE) throw new Error("Metadados do asset de wallpaper inválidos.");
    let url;
    try { url = new URL(payload.downloadUrl); } catch { throw new Error("URL de download inválida."); }
    if (!/^https?:$/.test(url.protocol) || url.origin !== serverHttpOrigin(serverUrl)) throw new Error("Origem de download não permitida.");
    if (url.pathname !== "/api/assets/wallpaper/current" || !url.searchParams.get("token") || url.searchParams.get("actionExecutionId") !== String(payload.actionExecutionId) || url.searchParams.get("assetId") !== ASSET_ID) throw new Error("URL de download inválida.");
    return url;
  }

  async function verify(filePath, expectedSha256, expectedSize) {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== expectedSize || info.size > MAX_SIZE) return false;
    if ((await hash(filePath)).toUpperCase() !== expectedSha256) return false;
    return isJpeg(await readFile(filePath));
  }

  return async function executeWallpaper(payload, applyWallpaper) {
    const url = validatePayload(payload);
    const expectedSha256 = String(payload.expectedSha256).toUpperCase();
    const expectedSize = payload.expectedSize;
    await mkdir(rootDir, { recursive: true });
    let cached = false;
    try { cached = await verify(finalPath, expectedSha256, expectedSize); } catch {}
    if (!cached) {
      if (typeof fetchImpl !== "function") throw new Error("Download indisponível.");
      const deviceId = getDownloadDeviceId();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
      const tempPath = path.join(rootDir, `.WallPaperVava.${crypto.randomUUID()}.tmp`);
      try {
        const response = await fetchImpl(url.href, { signal: controller.signal, headers: { "x-monitor-device-id": deviceId } });
        if (!response.ok) throw new Error("Download do asset recusado pelo Server.");
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length !== expectedSize || body.length > MAX_SIZE) throw new Error("Tamanho do asset inválido.");
        if (!isJpeg(body)) throw new Error("Formato do asset inválido.");
        await writeFile(tempPath, body, { flag: "wx" });
        if ((await hash(tempPath)).toUpperCase() !== expectedSha256) throw new Error("Hash do asset divergente.");
        try { await unlink(finalPath); } catch (err) { if (err.code !== "ENOENT") throw err; }
        await rename(tempPath, finalPath);
      } catch (err) {
        try { await unlink(tempPath); } catch {}
        throw new Error(err.name === "AbortError" ? "Timeout no download do wallpaper." : err.message);
      } finally { clearTimeout(timer); }
    }
    if (typeof applyWallpaper !== "function") throw new Error("Companion indisponível.");
    const result = await applyWallpaper({ path: finalPath, expectedSha256, style: "fill", actionExecutionId: payload.actionExecutionId });
    if (!result || result.applied !== true) throw new Error(result && result.error ? result.error : "Companion não aplicou o wallpaper.");
    return { ...result, wallpaperPath: finalPath, sha256: expectedSha256, size: expectedSize, cached };
  };
}

module.exports = { ASSET_ID, EXTENSION, MAX_SIZE, serverHttpOrigin, sha256File, isJpeg, createWallpaperExecutor };
