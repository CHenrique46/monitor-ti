const releasesService = require("../services/releases.service");

function badVersion(res) {
  return res.status(400).json({ erro: "Versao invalida." });
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

module.exports = { latest, getVersion, download, downloadPackage };
