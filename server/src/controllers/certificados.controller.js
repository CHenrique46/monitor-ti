const service = require("../services/certificados.service");

async function sincronizar(req, res) {
  try {
    return res.status(200).json(await service.syncCatalog());
  } catch (error) {
    if (["CERTIFICATE_ROOT_NOT_CONFIGURED", "CERTIFICATE_ROOT_UNAVAILABLE", "CERTIFICATE_ROOT_INVALID", "CERTIFICATE_SCAN_IN_PROGRESS"].includes(error.code)) {
      return res.status(error.code === "CERTIFICATE_SCAN_IN_PROGRESS" ? 409 : 503).json({ erro: error.message });
    }
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

module.exports = { sincronizar, listar, obter };
