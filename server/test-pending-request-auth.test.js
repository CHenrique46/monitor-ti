const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const { createAuthService, createPasswordHash } = require("./src/auth/service");
const { requireHumanSession, requireAdmin } = require("./src/auth/middleware");
const { createPortalRouter } = require("./src/routes/portal.routes");

function request(server, method, path, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method, path, ...(cookie ? { headers: { Cookie: cookie } } : {}) }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("resumo de solicitações exige sessão ADMIN e não é acessível ao VIEWER", async () => {
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("admin-pass"), viewerUsername: "viewer", viewerPasswordHash: createPasswordHash("viewer-pass") });
  const app = express();
  const router = createPortalRouter({ service: { pendingRequestSummary: async () => ({ pendentes: 2, ultimaSolicitacaoId: 8, ultimaSolicitacaoEm: "2026-09-15T01:00:00.000Z" }) }, humanSession: requireHumanSession(auth), requireAdmin });
  app.use("/api/certificados", router.admin);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/certificados/solicitacoes/resumo")).status, 401);
    const viewerLogin = auth.login({ username: "viewer", password: "viewer-pass", ip: "127.0.0.1" });
    assert.equal((await request(server, "GET", "/api/certificados/solicitacoes/resumo", `ht_session=${viewerLogin.sessionId}`)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
