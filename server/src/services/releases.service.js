const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const prisma = require("../prisma");
const { compareVersion } = require("./updateCommand");

// Raiz das releases: <repo>/releases/agent
const RELEASES_ROOT = path.join(__dirname, "..", "..", "..", "releases", "agent");

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PACKAGE_MODES = Object.freeze(["full", "agent-only"]);
const PACKAGE_FILES = Object.freeze({
  full: ["MonitorTI-Agent.exe", "MonitorTI-Notifier.exe", "notifier-integrity.json"],
  "agent-only": ["MonitorTI-Agent.exe"]
});

function validatePackageManifest(release) {
  const manifest = release && release.manifest;
  const packageMode = release && (release.packageMode || (manifest && manifest.packageMode));
  if (!PACKAGE_MODES.includes(packageMode) || !manifest || manifest.version !== release.version || !Array.isArray(manifest.files)) return false;
  const expected = PACKAGE_FILES[packageMode];
  if (manifest.files.length !== expected.length) return false;
  const names = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file.name !== "string" || !expected.includes(file.name) || names.has(file.name)) return false;
    if (!/^[a-f0-9]{64}$/i.test(String(file.sha256 || "")) || !Number.isInteger(file.size) || file.size <= 0) return false;
    names.add(file.name);
  }
  return expected.every((name) => names.has(name));
}

function releaseDir(version) {
  return path.join(RELEASES_ROOT, version);
}

// Retorna a release ativa (versão recomendada) ou null.
async function getActiveRelease() {
  const r = await prisma.agentRelease.findFirst({
    where: { active: true },
    orderBy: { releaseDate: "desc" }
  });
  return r ? toPublic(r) : null;
}

async function getRelease(version) {
  if (!VERSION_RE.test(version)) return null;
  const r = await prisma.agentRelease.findUnique({ where: { version } });
  return r ? toPublic(r) : null;
}

function toPublic(r) {
  return {
    id: r.id,
    version: r.version,
    fileName: r.fileName,
    sha256: r.sha256,
    size: r.size,
    packageName: r.packageName || null,
    packageSha256: r.packageSha256 || null,
    packageSize: r.packageSize || null,
    packageMode: r.packageMode || (r.manifest && r.manifest.packageMode) || null,
    manifest: r.manifest || null,
    releaseDate: r.releaseDate
  };
}

function hasArtifact(r, agentVersion) {
  const fileName = r && agentVersion && compareVersion(agentVersion, "1.1.1") >= 0 && r.packageName
    ? r.packageName
    : r && r.fileName;
  if (!fileName) return Promise.resolve(false);
  return agentVersion && compareVersion(agentVersion, "1.1.1") >= 0 && r.packageName
    ? verifyPackage(r)
    : verifyReleaseFile(r);
}

// Resolve o caminho do arquivo de forma segura (sem path traversal).
// O nome do arquivo vem do banco, nunca da requisição.
function resolveFile(version, fileName) {
  if (!VERSION_RE.test(version) || !fileName) return null;
  // Somente nomes conhecidos/permitidos (sem caminhos arbitrários).
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
  const dir = path.resolve(releaseDir(version));
  const full = path.resolve(dir, fileName);
  const dirResolved = dir + path.sep;
  if (full !== dir && !full.startsWith(dirResolved)) return null;
  return full;
}

function validIntegrityMetadata(sha256, size) {
  return /^[a-f0-9]{64}$/i.test(String(sha256 || "")) && Number.isInteger(size) && size > 0;
}

async function verifyFile(filePath, sha256, size) {
  if (!filePath || !validIntegrityMetadata(sha256, size)) return false;
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_) {
    return false;
  }
  if (!stat.isFile() || stat.size !== size) return false;

  return new Promise((resolve) => {
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    input.on("error", () => resolve(false));
    input.on("end", () => resolve(bytes === size && hash.digest("hex") === String(sha256).toLowerCase()));
  });
}

function manifestEntry(release, fileName) {
  if (!validatePackageManifest(release)) return null;
  return release.manifest.files.find((file) => file.name === fileName) || null;
}

async function verifyReleaseFile(release) {
  if (!release || !release.version || !release.fileName) return false;
  const entry = release.manifest ? manifestEntry(release, release.fileName) : null;
  if (release.manifest && (!entry || entry.sha256.toLowerCase() !== String(release.sha256).toLowerCase() || entry.size !== release.size)) return false;
  const filePath = resolveFile(release.version, release.fileName);
  return verifyFile(filePath, release.sha256, release.size);
}

async function verifyPackage(release) {
  if (!release || !release.packageName || !validatePackageManifest(release)) return false;
  const filePath = resolveFile(release.version, release.packageName);
  return verifyFile(filePath, release.packageSha256, release.packageSize);
}

async function streamValidatedFile(sourcePath, downloadName, sha256, size, res, deps = {}) {
  if (!(await (deps.verifyFile || verifyFile)(sourcePath, sha256, size))) return false;
  const tempRoot = path.dirname(sourcePath);
  let tempDir;
  try {
    tempDir = await (deps.mkdtemp || fs.promises.mkdtemp)(path.join(tempRoot, ".agent-download-"));
    const tempPath = path.join(tempDir, path.basename(sourcePath));
    await (deps.copyFile || fs.promises.copyFile)(sourcePath, tempPath);
    if (!(await (deps.verifyFile || verifyFile)(tempPath, sha256, size))) {
      await (deps.rm || fs.promises.rm)(tempDir, { recursive: true, force: true });
      return false;
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      void (deps.rm || fs.promises.rm)(tempDir, { recursive: true, force: true });
    };
    if (res && typeof res.once === "function") {
      res.once("close", cleanup);
      res.once("error", cleanup);
    }
    try {
      res.download(tempPath, downloadName, cleanup);
    } catch (error) {
      cleanup();
      return false;
    }
    return true;
  } catch (error) {
    if (tempDir) await (deps.rm || fs.promises.rm)(tempDir, { recursive: true, force: true });
    return false;
  }
}

async function streamRelease(version, res, deps = {}) {
  const r = await (deps.getRelease || getRelease)(version);
  if (!r) return false;
  const filePath = resolveFile(version, r.fileName);
  if (!filePath) return false;
  const entry = r.manifest ? manifestEntry(r, r.fileName) : null;
  if (r.manifest && (!entry || entry.sha256.toLowerCase() !== String(r.sha256).toLowerCase() || entry.size !== r.size)) return false;
  return streamValidatedFile(filePath, r.fileName, r.sha256, r.size, res, deps);
}

// Serve o pacote (zip com Agent + Notifier + manifest). Somente versões que
// realmente possuem pacote.
async function streamPackage(version, res, deps = {}) {
  const r = await (deps.getRelease || getRelease)(version);
  if (!r || !r.packageName || !validatePackageManifest(r)) return false;
  const filePath = resolveFile(version, r.packageName);
  if (!filePath) return false;
  return streamValidatedFile(filePath, r.packageName, r.packageSha256, r.packageSize, res, deps);
}

module.exports = {
  RELEASES_ROOT,
  VERSION_RE,
  PACKAGE_MODES,
  PACKAGE_FILES,
  validatePackageManifest,
  getActiveRelease,
  getRelease,
  toPublic,
  resolveFile,
  verifyFile,
  verifyReleaseFile,
  verifyPackage,
  streamValidatedFile,
  streamRelease,
  streamPackage,
  hasArtifact
};
