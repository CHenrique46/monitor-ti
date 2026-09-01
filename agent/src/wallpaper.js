const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ASSET_ID = "official-wallpaper-v1";
const SHA256 = "F5D2B5A264D60A9FC3FA8D130C0D9412411C98F753C10F2D0F441A4326CFE69E";
const SIZE = 174163;
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

function createWallpaperExecutor(deps = {}) {
  const rootDir = deps.rootDir || path.join(process.env.ProgramData || "C:\\ProgramData", "MonitorTI", "wallpaper");
  const finalPath = path.join(rootDir, "WallPaperVava.jpg");
  const fetchImpl = deps.fetch || globalThis.fetch;
  const serverUrl = deps.serverUrl;
  const downloadTimeoutMs = deps.downloadTimeoutMs || 60000;
  const mkdir = deps.mkdir || fs.promises.mkdir;
  const stat = deps.stat || fs.promises.stat;
  const hash = deps.sha256File || sha256File;
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
    if (!payload || payload.assetId !== ASSET_ID || payload.extension !== EXTENSION || payload.size !== SIZE || String(payload.sha256 || "").toUpperCase() !== SHA256) throw new Error("Asset de wallpaper inválido.");
    let url;
    try { url = new URL(payload.downloadUrl); } catch { throw new Error("URL de download inválida."); }
    if (!/^https?:$/.test(url.protocol) || url.origin !== serverHttpOrigin(serverUrl)) throw new Error("Origem de download não permitida.");
    if (url.pathname !== "/api/assets/wallpaper/current" || !url.searchParams.get("token") || url.searchParams.get("actionExecutionId") !== String(payload.actionExecutionId) || url.searchParams.get("assetId") !== ASSET_ID) throw new Error("URL de download inválida.");
    return url;
  }

  async function verify(filePath) {
    const info = await stat(filePath);
    if (!info.isFile() || info.size !== SIZE || info.size > MAX_SIZE) return false;
    return (await hash(filePath)).toUpperCase() === SHA256;
  }

  return async function executeWallpaper(payload, applyWallpaper) {
    validatePayload(payload);
    await mkdir(rootDir, { recursive: true });
    let cached = false;
    try { cached = await verify(finalPath); } catch {}
    if (!cached) {
      if (typeof fetchImpl !== "function") throw new Error("Download indisponível.");
      const deviceId = getDownloadDeviceId();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
      const tempPath = path.join(rootDir, `.WallPaperVava.${crypto.randomUUID()}.tmp`);
      try {
        const response = await fetchImpl(payload.downloadUrl, { signal: controller.signal, headers: { "x-monitor-device-id": deviceId } });
        if (!response.ok) throw new Error("Download do asset recusado pelo Server.");
        const body = Buffer.from(await response.arrayBuffer());
        if (body.length !== SIZE || body.length > MAX_SIZE) throw new Error("Tamanho do asset inválido.");
        await writeFile(tempPath, body, { flag: "wx" });
        if ((await hash(tempPath)).toUpperCase() !== SHA256) throw new Error("Hash do asset divergente.");
        try { await unlink(finalPath); } catch (err) { if (err.code !== "ENOENT") throw err; }
        await rename(tempPath, finalPath);
      } catch (err) {
        try { await unlink(tempPath); } catch {}
        throw new Error(err.name === "AbortError" ? "Timeout no download do wallpaper." : err.message);
      } finally { clearTimeout(timer); }
    }
    if (typeof applyWallpaper !== "function") throw new Error("Companion indisponível.");
    const result = await applyWallpaper({ path: finalPath, expectedSha256: SHA256, style: "fill", actionExecutionId: payload.actionExecutionId });
    if (!result || result.applied !== true) throw new Error(result && result.error ? result.error : "Companion não aplicou o wallpaper.");
    return { ...result, wallpaperPath: finalPath, sha256: SHA256, cached };
  };
}

module.exports = { ASSET_ID, SHA256, SIZE, EXTENSION, MAX_SIZE, serverHttpOrigin, sha256File, createWallpaperExecutor };
