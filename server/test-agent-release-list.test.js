const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const { createAgentRouter } = require("./src/routes/agent.routes");
const { createAuthService, createPasswordHash } = require("./src/auth/service");
const { createAuthRouter } = require("./src/routes/auth.routes");

function request(server, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request({ port: server.address().port, method, path, headers: { ...(body != null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("catálogo de releases exige ADMIN e inclui inactive", async () => {
  const auth = createAuthService({
    username: "admin",
    passwordHash: createPasswordHash("admin-pass", { salt: "0123456789abcdef0123456789abcdef" }),
    viewerUsername: "viewer",
    viewerPasswordHash: createPasswordHash("viewer-pass", { salt: "fedcba9876543210fedcba9876543210" })
  });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ authService: auth }));
  app.use("/api/agent", createAgentRouter({
    authService: auth,
    releaseController: { list: (_req, res) => res.json([{ id: 26, version: "1.1.24", active: false, createdAt: "2026-09-11T00:00:00.000Z" }]) }
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/agent/releases")).status, 401);
    const viewerLogin = await request(server, "POST", "/api/auth/login", { username: "viewer", password: "viewer-pass" });
    const viewerCookie = viewerLogin.headers["set-cookie"][0].split(";", 1)[0];
    assert.equal((await request(server, "GET", "/api/agent/releases", null, viewerCookie)).status, 403);
    const adminLogin = await request(server, "POST", "/api/auth/login", { username: "admin", password: "admin-pass" });
    const adminCookie = adminLogin.headers["set-cookie"][0].split(";", 1)[0];
    const catalog = await request(server, "GET", "/api/agent/releases", null, adminCookie);
    assert.equal(catalog.status, 200);
    assert.deepEqual(catalog.body, [{ id: 26, version: "1.1.24", active: false, createdAt: "2026-09-11T00:00:00.000Z" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
