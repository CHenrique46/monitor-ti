const express = require("express");
const { requireHumanSession } = require("../auth/middleware");
const { createPortalController, readPortalCookie } = require("../controllers/portal.controller");
const { browserNotificationHub } = require("../services/browserNotificationHub");

function assertOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const expected = `${req.protocol}://${req.get("host")}`;
  return origin === expected;
}

function stream(req, res, hub, scope, authorize, heartbeatMs = 25000) {
  if (!assertOrigin(req)) return res.status(403).json({ erro: "Origem não autorizada." });
  if (!hub.isEnabled()) return res.status(404).json({ erro: "Notificações do navegador indisponíveis." });
  let unsubscribe;
  try { unsubscribe = hub.subscribe(scope, (event) => res.write(`data: ${JSON.stringify(event)}\n\n`), authorize); } catch (error) {
    if (error.code === "BROWSER_NOTIFICATION_CONNECTION_LIMIT") return res.status(503).json({ erro: "Limite de conexões de notificações atingido." });
    return res.status(503).json({ erro: "Canal de notificações indisponível." });
  }
  res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders?.();
  res.write(": ready\n\n");
  const close = () => { clearInterval(heartbeat); unsubscribe?.(); if (!res.writableEnded) res.end(); };
  const heartbeat = setInterval(() => { try { if (!authorize()) return close(); res.write(": heartbeat\n\n"); } catch { close(); } }, heartbeatMs);
  req.on("close", () => { clearInterval(heartbeat); unsubscribe?.(); });
  return undefined;
}

function rejectBody(req, res) {
  if (req.body && Object.keys(req.body).length > 0) return res.status(400).json({ erro: "Payload não permitido." });
  return null;
}

function createBrowserNotificationRouters({ hub = browserNotificationHub, authService, portalService, heartbeatMs = 25000 } = {}) {
  const admin = express.Router();
  const portal = express.Router();
  const humanSession = requireHumanSession(authService);
  const portalController = createPortalController({ service: portalService });
  const requireAdmin = (req, res, next) => { if (req.humanUser?.role !== "ADMIN") return res.status(403).json({ erro: "Acesso restrito." }); return next(); };

  admin.get("/status", humanSession, requireAdmin, (_req, res) => res.status(200).json({ enabled: hub.isEnabled(), channel: "sse", requiresOpenPage: true }));
  admin.get("/events", humanSession, requireAdmin, (req, res) => stream(req, res, hub, "admin", () => Boolean(authService.getRequestSession(req)?.role === "ADMIN"), heartbeatMs));
  admin.post("/test", humanSession, requireAdmin, (req, res) => { const invalid = rejectBody(req, res); if (invalid) return invalid; if (!hub.isEnabled()) return res.status(404).json({ erro: "Notificações do navegador indisponíveis." }); hub.publishAdmin("CERTIFICATE_REQUEST_CREATED"); return res.status(204).end(); });

  portal.get("/status", portalController.requireSession, (_req, res) => res.status(200).json({ enabled: hub.isEnabled(), channel: "sse", requiresOpenPage: true }));
  portal.get("/events", portalController.requireSession, (req, res) => stream(req, res, hub, `computer:${Number(req.portalSession.computerId)}`, () => portalService.isSessionActive(readPortalCookie(req), req.ip), heartbeatMs));
  portal.post("/test", portalController.requireSession, (req, res) => { const invalid = rejectBody(req, res); if (invalid) return invalid; if (!hub.isEnabled()) return res.status(404).json({ erro: "Notificações do navegador indisponíveis." }); hub.publishComputer(req.portalSession.computerId, "CERTIFICATE_RELEASED"); return res.status(204).end(); });
  return { admin, portal };
}

module.exports = { createBrowserNotificationRouters, assertOrigin };
