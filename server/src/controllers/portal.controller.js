const { PORTAL_COOKIE } = require("../services/portal.service");

function readPortalCookie(req) {
  const item = String(req.headers.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${PORTAL_COOKIE}=`));
  if (!item) return "";
  try { return decodeURIComponent(item.slice(PORTAL_COOKIE.length + 1)); } catch { return ""; }
}

function createPortalController({ service, lucaService = null }) {
  async function start(req, res) {
    try {
      const result = await service.createSession(req.ip);
      res.set("Set-Cookie", service.cookie(result.id));
      res.set("Cache-Control", "no-store");
      return res.status(200).json({ hostname: result.computer.hostname, usuarioWindows: result.computer.usuario || null, expiresAt: new Date(result.expiresAt).toISOString(), identificacao: "Esta sessão representa a estação que iniciou o acesso." });
    } catch (error) { return sendError(res, error); }
  }

  async function requireSession(req, res, next) {
    try {
      const session = await service.getSession(readPortalCookie(req), req.ip);
      if (!session) return res.status(401).json({ erro: "Sessão do portal expirada." });
      req.portalSession = session;
      res.set("Cache-Control", "no-store");
      return next();
    } catch (error) { return sendError(res, error); }
  }

  async function session(req, res) { return res.status(200).json({ hostname: req.portalSession.computer.hostname, usuarioWindows: req.portalSession.computer.usuario || null, expiresAt: new Date(req.portalSession.expiresAt).toISOString(), identificacao: "Esta sessão representa a estação que iniciou o acesso." }); }
  async function catalog(req, res) { try { return res.status(200).json(await service.listCertificates(req.query)); } catch (error) { return sendError(res, error); } }
  async function converse(req, res) {
    if (!lucaService) return res.status(503).json({ erro: "O Luca esta indisponivel." });
    try {
      const body = req.body || {};
      const result = await lucaService.converse({ conversationKey: String(req.portalSession.computerId), sessionId: body.sessionId, message: body.message, phase: body.phase });
      return res.status(200).json(result);
    } catch (error) {
      const status = { LUCA_INPUT_INVALID: 400, LUCA_QUEUE_FULL: 429, LUCA_RATE_LIMITED: 429, LUCA_TIMEOUT: 503, LUCA_RESPONSE_INVALID: 503, LUCA_RESPONSE_TRUNCATED: 503, LUCA_OLLAMA_UNAVAILABLE: 503, LUCA_OLLAMA_URL_INVALID: 503, LUCA_GROQ_UNAVAILABLE: 503, LUCA_GROQ_NOT_CONFIGURED: 503, LUCA_PROVIDER_INVALID: 503 }[error.code] || 503;
      return res.status(status).json({ erro: status === 429 ? error.message : "O Luca esta indisponivel. Use a pesquisa tradicional." });
    }
  }
  async function createRequest(req, res) { try { return res.status(201).json(await service.createRequest(req.portalSession, req.body)); } catch (error) { return sendError(res, error); } }
  async function listOwnRequests(req, res) { try { return res.status(200).json(await service.listOwnRequests(req.portalSession, req.query)); } catch (error) { return sendError(res, error); } }
  async function pendingRequestSummary(req, res) { try { return res.status(200).json(await service.pendingRequestSummary()); } catch (error) { return sendError(res, error); } }
  async function logout(req, res) { service._sessions.delete(readPortalCookie(req)); res.set("Set-Cookie", service.expiredCookie()); return res.status(204).end(); }
  async function listRequests(req, res) { try { return res.status(200).json(await service.listRequests()); } catch (error) { return sendError(res, error); } }
  async function decideRequest(req, res) { try { return res.status(200).json(await service.decideRequest(req.params.id, req.body, req.humanUser.username)); } catch (error) { return sendError(res, error); } }

  return { start, requireSession, session, catalog, createRequest, listOwnRequests, converse, pendingRequestSummary, logout, listRequests, decideRequest };
}

function sendError(res, error) {
  const status = { PORTAL_IP_INVALID: 403, PORTAL_LOOPBACK_BLOCKED: 403, PORTAL_COMPUTER_NOT_FOUND: 403, PORTAL_COMPUTER_AMBIGUOUS: 409, INVALID_CERTIFICATE: 400, INVALID_REQUEST: 400, CERTIFICATE_NOT_FOUND: 404, DUPLICATE_REQUEST: 409, INVALID_ID: 400, INVALID_STATE: 400, DENIAL_REASON_REQUIRED: 400, NOT_FOUND: 404, INVALID_TRANSITION: 409, RELEASE_FAILED: 409, RELEASE_REVIEW_REQUIRED: 409 }[error.code] || 500;
  return res.status(status).json({ erro: error.message || "Não foi possível concluir a operação." });
}

module.exports = { createPortalController, readPortalCookie };
