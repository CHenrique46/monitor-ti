const express = require("express");
const { createPortalController } = require("../controllers/portal.controller");

function createPortalRouter({ service, humanSession, requireAdmin }) {
  const controller = createPortalController({ service });
  const portal = express.Router();
  portal.post("/session", controller.start);
  portal.get("/session", controller.requireSession, controller.session);
  portal.post("/logout", controller.logout);
  portal.get("/certificados", controller.requireSession, controller.catalog);
  portal.post("/solicitacoes", controller.requireSession, controller.createRequest);
  portal.get("/solicitacoes", controller.requireSession, controller.listOwnRequests);

  const admin = express.Router();
  admin.get("/solicitacoes/resumo", humanSession, requireAdmin(), controller.pendingRequestSummary);
  admin.get("/solicitacoes", humanSession, requireAdmin(), controller.listRequests);
  admin.patch("/solicitacoes/:id", humanSession, requireAdmin(), controller.decideRequest);
  admin.post("/solicitacoes/:id/retry-authorization", humanSession, requireAdmin(), controller.authorizeExtraordinaryRetry);
  admin.delete("/solicitacoes/:id/retry-authorization", humanSession, requireAdmin(), controller.cancelExtraordinaryRetry);
  return { portal, admin };
}

module.exports = { createPortalRouter };
