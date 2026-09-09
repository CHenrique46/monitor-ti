const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { compareVersion } = require("./updateCommand");

// Raiz das releases: <repo>/releases/agent
const RELEASES_ROOT = path.join(__dirname, "..", "..", "..", "releases", "agent");

const VERSION_RE = /^\d+\.\d+\.\d+$/;

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
    manifest: r.manifest || null,
    releaseDate: r.releaseDate
  };
}

function hasArtifact(r, agentVersion) {
  const fileName = agentVersion && compareVersion(agentVersion, "1.1.1") >= 0 && r.packageName
    ? r.packageName
    : r.fileName;
  return !!fileName && !!fs.existsSync(resolveFile(r.version, fileName));
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

async function streamRelease(version, res) {
  const r = await getRelease(version);
  if (!r) return false;
  const filePath = resolveFile(version, r.fileName);
  if (!filePath || !fs.existsSync(filePath)) return false;
  res.download(filePath, r.fileName);
  return true;
}

// Serve o pacote (zip com Agent + Notifier + manifest). Somente versões que
// realmente possuem pacote.
async function streamPackage(version, res) {
  const r = await getRelease(version);
  if (!r || !r.packageName) return false;
  const filePath = resolveFile(version, r.packageName);
  if (!filePath || !fs.existsSync(filePath)) return false;
  res.download(filePath, r.packageName);
  return true;
}

module.exports = {
  RELEASES_ROOT,
  VERSION_RE,
  getActiveRelease,
  getRelease,
  toPublic,
  resolveFile,
  streamRelease,
  streamPackage,
  hasArtifact
};
