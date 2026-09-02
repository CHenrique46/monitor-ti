const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const express = require("express");
const { createAuthService, createPasswordHash, SESSION_TTL_MS } = require("./src/auth/service");
const { createAuthRouter } = require("./src/routes/auth.routes");
const { requireHumanSession } = require("./src/auth/middleware");

function request(server, method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? "" : JSON.stringify(body);
    const req = http.request({ port: server.address().port, method, path, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), ...(cookie ? { Cookie: cookie } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : null }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("login, sessão, refresh lógico, logout e expiração", async () => {
  let now = 1000;
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("senha-local", { salt: "0123456789abcdef0123456789abcdef" }), now: () => now, randomBytes: () => Buffer.alloc(32, 7) });
  const app = express();
  app.use(express.json());
  app.use("/api/auth", createAuthRouter({ authService: auth }));
  app.get("/admin", requireHumanSession(auth), (req, res) => res.json({ username: req.humanUser.username }));
  app.get("/technical", (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/auth/me")).status, 401);
    const login = await request(server, "POST", "/api/auth/login", { username: "admin", password: "senha-local" });
    assert.equal(login.status, 200);
    assert.match(login.headers["set-cookie"][0], /HttpOnly/);
    assert.match(login.headers["set-cookie"][0], /SameSite=Lax/);
    assert.equal(login.body.username, "admin");
    assert.equal(Object.prototype.hasOwnProperty.call(login.body, "passwordHash"), false);
    const cookie = login.headers["set-cookie"][0].split(";", 1)[0];
    assert.deepEqual((await request(server, "GET", "/api/auth/me", null, cookie)).body.username, "admin");
    assert.deepEqual((await request(server, "GET", "/admin", null, cookie)).body, { username: "admin" });
    assert.equal((await request(server, "GET", "/technical")).status, 200);
    assert.equal((await request(server, "POST", "/api/auth/logout", null, cookie)).status, 204);
    assert.equal((await request(server, "GET", "/admin", null, cookie)).status, 401);
    const loginAgain = await request(server, "POST", "/api/auth/login", { username: "admin", password: "senha-local" });
    const expiredCookie = loginAgain.headers["set-cookie"][0].split(";", 1)[0];
    now += SESSION_TTL_MS + 1;
    assert.equal((await request(server, "GET", "/api/auth/me", null, expiredCookie)).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("credenciais inválidas são genéricas e rate limit é por IP", () => {
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("senha-local", { salt: "fedcba9876543210fedcba9876543210" }) });
  const first = auth.login({ username: "admin", password: "errada", ip: "10.0.0.1" });
  assert.equal(first.status, 401);
  assert.equal(first.code, "INVALID_CREDENTIALS");
  for (let i = 0; i < 4; i++) auth.login({ username: "admin", password: "errada", ip: "10.0.0.1" });
  assert.equal(auth.login({ username: "admin", password: "senha-local", ip: "10.0.0.1" }).status, 429);
  assert.equal(auth.login({ username: "admin", password: "senha-local", ip: "10.0.0.2" }).ok, true);
});

test("rotas administrativas exigem sessão, mas wallpaper técnico não", async () => {
  const app = require("./src/app");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await request(server, "GET", "/api/computadores")).status, 401);
    assert.equal((await request(server, "POST", "/api/computadores/1/actions/spooler-reset", {})).status, 401);
    assert.equal((await request(server, "GET", "/api/assets/wallpaper/current?token=invalid&actionExecutionId=a&assetId=official-wallpaper-v1")).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
