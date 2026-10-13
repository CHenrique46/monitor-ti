const service = require("../services/certificados.service");
const defaultSyncService = require("../services/certificateCatalogSync.service");

function createCertificadosController({ syncService = defaultSyncService, releaseService } = {}) {
async function sincronizar(req, res) {
  try {
    return res.status(200).json(await syncService.runManual(req.humanUser && req.humanUser.username));
  } catch (error) {
    if (["CERTIFICATE_ROOT_NOT_CONFIGURED", "CERTIFICATE_ROOT_UNAVAILABLE", "CERTIFICATE_ROOT_INVALID", "CERTIFICATE_SYNC_FAILED"].includes(error.code)) {
      return res.status(503).json({ erro: error.message });
    }
    if (["CERTIFICATE_SYNC_IN_PROGRESS", "CERTIFICATE_SCAN_IN_PROGRESS"].includes(error.code)) return res.status(409).json({ erro: "Já existe uma sincronização em andamento." });
    return res.status(500).json({ erro: "Não foi possível sincronizar o catálogo de certificados." });
  }
}

async function listar(req, res) {
  try {
    return res.status(200).json(await service.listCertificates({ query: req.query }));
  } catch (error) {
    if (error.code === "INVALID_QUERY") return res.status(400).json({ erro: error.message });
    return res.status(500).json({ erro: "Não foi possível consultar o catálogo de certificados." });
  }
}

async function obter(req, res) {
  try {
    const result = await service.getCertificate(req.params.id);
    if (!result) return res.status(404).json({ erro: "Certificado não encontrado." });
    return res.status(200).json(result);
  } catch (error) {
    if (error.code === "INVALID_ID") return res.status(400).json({ erro: error.message });
    return res.status(500).json({ erro: "Não foi possível consultar o certificado." });
  }
}

  async function storageStatus(req, res) {
    try {
      return res.status(200).json(await service.checkStorageAccess());
    } catch {
      return res.status(200).json({
        configurationPresent: false,
        pathRecognized: false,
        pathReachable: false,
        isDirectory: false,
        readAccess: false,
        errorCode: "DIAGNOSTIC_FAILED"
      });
    }
  }

  async function sourceDiagnostic(req, res) {
    res.set("Cache-Control", "no-store");
    try {
      const diagnose = releaseService?.diagnoseSourceRoot || service.diagnoseSourceRoot;
      return res.status(200).json(await diagnose());
    } catch {
      return res.status(200).json({ etapa: "SOURCE_ROOT", codigo: "DIAGNOSTIC_FAILED" });
    }
  }

async function sincronizacoes(req, res) {
  try { return res.status(200).json(await syncService.listHistory(req.query.limit)); }
  catch (error) { return res.status(error.code === "INVALID_LIMIT" ? 400 : 500).json({ erro: error.message || "Não foi possível consultar o histórico de sincronização." }); }
}

async function sincronizacaoAtual(req, res) {
  try { return res.status(200).json(await syncService.current()); }
  catch { return res.status(500).json({ erro: "Não foi possível consultar a sincronização atual." }); }
}

 return { sincronizar, listar, obter, storageStatus, sourceDiagnostic, sincronizacoes, sincronizacaoAtual };
}

module.exports = { ...createCertificadosController(), createCertificadosController };
