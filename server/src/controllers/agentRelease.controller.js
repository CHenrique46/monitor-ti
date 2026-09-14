const releasesService = require("../services/releases.service");
const prisma = require("../prisma");

function badVersion(res) {
  return res.status(400).json({ erro: "Versao invalida." });
}

async function list(req, res) {
  try {
    const releases = await prisma.agentRelease.findMany({
      select: { id: true, version: true, active: true, releaseDate: true },
      orderBy: { releaseDate: "desc" }
    });
    return res.status(200).json(releases.map((release) => ({
      id: release.id,
      version: release.version,
      active: release.active,
      createdAt: release.releaseDate
    })));
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

async function latest(req, res) {
  try {
    const r = await releasesService.getActiveRelease();
    if (!r) return res.status(404).json({ erro: "Nenhuma release ativa." });
    return res.status(200).json(r);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

async function getVersion(req, res) {
  try {
    const v = req.params.version;
    if (!releasesService.VERSION_RE.test(v)) return badVersion(res);
    const r = await releasesService.getRelease(v);
    if (!r) return res.status(404).json({ erro: "Release nao encontrada." });
    return res.status(200).json(r);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

async function download(req, res) {
  try {
    const v = req.params.version;
    if (!releasesService.VERSION_RE.test(v)) return badVersion(res);
    const ok = await releasesService.streamRelease(v, res);
    if (!ok) return res.status(404).json({ erro: "Arquivo de release nao encontrado." });
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ erro: err.message });
  }
}

async function downloadPackage(req, res) {
  try {
    const v = req.params.version;
    if (!releasesService.VERSION_RE.test(v)) return badVersion(res);
    const ok = await releasesService.streamPackage(v, res);
    if (!ok) return res.status(404).json({ erro: "Pacote de release nao encontrado." });
  } catch (err) {
    if (!res.headersSent) return res.status(500).json({ erro: err.message });
  }
}

module.exports = { list, latest, getVersion, download, downloadPackage };
