const express = require("express");
const { createPortalController } = require("../controllers/portal.controller");

function createPortalRouter({ service, humanSession, requireAdmin, lucaService = null }) {
  const controller = createPortalController({ service, lucaService });
  const portal = express.Router();
  portal.post("/session", controller.start);
  portal.get("/session", controller.requireSession, controller.session);
  portal.post("/logout", controller.logout);
  portal.get("/certificados", controller.requireSession, controller.catalog);
  portal.post("/solicitacoes", controller.requireSession, controller.createRequest);
  portal.get("/solicitacoes", controller.requireSession, controller.listOwnRequests);
  portal.post("/luca/conversa", controller.requireSession, controller.converse);

  const admin = express.Router();
  admin.get("/solicitacoes/resumo", humanSession, requireAdmin(), controller.pendingRequestSummary);
  admin.get("/solicitacoes", humanSession, requireAdmin(), controller.listRequests);
  admin.patch("/solicitacoes/:id", humanSession, requireAdmin(), controller.decideRequest);
  return { portal, admin };
}

module.exports = { createPortalRouter };
