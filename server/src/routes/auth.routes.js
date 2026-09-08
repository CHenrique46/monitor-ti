const express = require("express");
const { createAuthService, COOKIE_NAME } = require("../auth/service");

function createAuthRouter({ authService = createAuthService() } = {}) {
  const router = express.Router();

  router.post("/login", (req, res) => {
    const result = authService.login({
      username: req.body && req.body.username,
      password: req.body && req.body.password,
      ip: req.ip
    });
    if (!result.ok) {
      if (result.retryAfter) res.set("Retry-After", String(result.retryAfter));
      return res.status(result.status).json({ erro: result.code === "RATE_LIMITED" ? "Muitas tentativas. Tente novamente mais tarde." : "Credenciais inválidas." });
    }
    res.set("Set-Cookie", authService.sessionCookie(result.sessionId, req.secure || undefined));
    return res.status(200).json({ username: result.username, role: result.role, expiresAt: new Date(result.expiresAt).toISOString() });
  });

  router.get("/me", (req, res) => {
    const session = authService.getRequestSession(req);
    if (!session) return res.status(401).json({ erro: "Sessão necessária." });
    return res.status(200).json({ username: session.username, role: session.role || "ADMIN", expiresAt: new Date(session.expiresAt).toISOString() });
  });

  router.post("/logout", (req, res) => {
    const cookies = String(req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(COOKIE_NAME + "="));
    authService.logout(cookies ? decodeURIComponent(cookies.slice(COOKIE_NAME.length + 1)) : "");
    res.set("Set-Cookie", authService.expiredCookie(req.secure || undefined));
    return res.status(204).end();
  });

  return router;
}

module.exports = { createAuthRouter };
