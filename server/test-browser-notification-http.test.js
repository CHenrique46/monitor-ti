const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("http");
const { createAuthService, createPasswordHash } = require("./src/auth/service");
const { createBrowserNotificationHub } = require("./src/services/browserNotificationHub");
const { createBrowserNotificationRouters } = require("./src/routes/browserNotification.routes");

function waitForClose(hub) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (hub.connectionCount() === 0) return resolve();
      if (Date.now() - started > 1000) return reject(new Error("subscriber cleanup timeout"));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function jsonRequest(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method, path, headers }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: responseBody ? JSON.parse(responseBody) : null }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function openSse(server, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port: server.address().port, method: "GET", path, headers }, (res) => {
      let data = "";
      res.once("data", (chunk) => resolve({ req, res, data: data + chunk.toString() }));
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("error", reject);
      res.on("end", () => { if (res.statusCode !== 200) resolve({ res, data }); });
    });
    req.on("error", reject);
    req.end();
  });
}

function setup({ enabled = "1", maxConnections = 10, heartbeatMs = 20 } = {}) {
  let now = Date.now();
  const auth = createAuthService({ username: "admin", passwordHash: createPasswordHash("admin-pass"), viewerUsername: "viewer", viewerPasswordHash: createPasswordHash("viewer-pass"), now: () => now });
  const portalSessions = new Map();
  const normalizeIp = (ip) => String(ip || "").replace(/^::ffff:/, "");
  const portalService = {
    async getSession(id, ip) {
      const session = portalSessions.get(String(id));
      if (!session || session.expiresAt <= now || normalizeIp(session.ip) !== normalizeIp(ip) || session.valid === false) return null;
      return { ...session, computer: { id: session.computerId, hostname: "PILOT", usuario: "anderson" } };
    },
    isSessionActive(id, ip) {
      const session = portalSessions.get(String(id));
      return Boolean(session && session.valid !== false && session.expiresAt > now && normalizeIp(session.ip) === normalizeIp(ip));
    }
  };
  const env = { MTI_BROWSER_CERTIFICATE_NOTIFICATIONS: enabled };
  const hub = createBrowserNotificationHub({ env, maxConnections });
  const routers = createBrowserNotificationRouters({ hub, authService: auth, portalService, heartbeatMs });
  const app = express();
  app.use(express.json());
  app.use("/api/browser-notifications", routers.admin);
  app.use("/api/portal/browser-notifications", routers.portal);
  const server = http.createServer(app);
  return { auth, portalSessions, hub, app, server, now: (value) => { now = value; } };
}

test("SSE ADMIN exige ADMIN, valida Origin e expõe headers corretos", async () => {
  const fixture = setup();
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/browser-notifications/events")).status, 401);
    const viewer = fixture.auth.login({ username: "viewer", password: "viewer-pass", ip: "127.0.0.1" });
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/browser-notifications/events", { Cookie: `ht_session=${viewer.sessionId}` })).status, 403);
    const admin = fixture.auth.login({ username: "admin", password: "admin-pass", ip: "127.0.0.1" });
    const badOrigin = await jsonRequest(fixture.server, "GET", "/api/browser-notifications/events", { Cookie: `ht_session=${admin.sessionId}`, Origin: "http://evil.invalid" });
    assert.equal(badOrigin.status, 403);
    const extraPayload = await jsonRequest(fixture.server, "POST", "/api/browser-notifications/test", { Cookie: `ht_session=${admin.sessionId}`, "Content-Type": "application/json" }, JSON.stringify({ computerId: 999 }));
    assert.equal(extraPayload.status, 400);
    const host = `http://127.0.0.1:${fixture.server.address().port}`;
    const open = await openSse(fixture.server, "/api/browser-notifications/events?computerId=999", { Cookie: `ht_session=${admin.sessionId}`, Origin: host, Host: `127.0.0.1:${fixture.server.address().port}` });
    assert.equal(open.res.statusCode, 200);
    assert.match(open.res.headers["content-type"], /^text\/event-stream/);
    assert.equal(open.res.headers["cache-control"], "no-cache, no-store");
    assert.equal(open.res.headers.connection, "keep-alive");
    assert.equal(open.res.headers["x-accel-buffering"], "no");
    assert.match(open.data, /: ready/);
    open.req.destroy();
    await waitForClose(fixture.hub);
    const absentOrigin = await openSse(fixture.server, "/api/browser-notifications/events", { Cookie: `ht_session=${admin.sessionId}` });
    assert.equal(absentOrigin.res.statusCode, 200);
    absentOrigin.req.destroy();
    await waitForClose(fixture.hub);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("SSE portal usa apenas computerId da sessão e rejeita sessão/IP/estação inválidos", async () => {
  const fixture = setup();
  fixture.portalSessions.set("portal-1", { computerId: 7, ip: "127.0.0.1", expiresAt: Date.now() + 10000 });
  fixture.portalSessions.set("portal-expired", { computerId: 7, ip: "127.0.0.1", expiresAt: 0 });
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/portal/browser-notifications/events")).status, 401);
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/portal/browser-notifications/events", { Cookie: "ht_portal_session=portal-expired" })).status, 401);
    const valid = await openSse(fixture.server, "/api/portal/browser-notifications/events?computerId=999", { Cookie: "ht_portal_session=portal-1", "X-Computer-ID": "999", Host: "127.0.0.1" });
    assert.equal(valid.res.statusCode, 200);
    valid.res.destroy();
    valid.req.destroy();
    await waitForClose(fixture.hub);
    fixture.portalSessions.get("portal-1").valid = false;
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/portal/browser-notifications/events", { Cookie: "ht_portal_session=portal-1" })).status, 401);
    fixture.portalSessions.set("portal-2", { computerId: 8, ip: "10.0.0.8", expiresAt: Date.now() + 10000 });
    assert.equal((await jsonRequest(fixture.server, "GET", "/api/portal/browser-notifications/events", { Cookie: "ht_portal_session=portal-2", "X-Forwarded-For": "10.0.0.7" })).status, 401);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("flag desligada impede assinatura e limite retorna 503", async () => {
  const disabled = setup({ enabled: "0" });
  const disabledAdmin = disabled.auth.login({ username: "admin", password: "admin-pass", ip: "127.0.0.1" });
  await new Promise((resolve) => disabled.server.listen(0, "127.0.0.1", resolve));
  try { assert.equal((await jsonRequest(disabled.server, "GET", "/api/browser-notifications/events", { Cookie: `ht_session=${disabledAdmin.sessionId}` })).status, 404); } finally { await new Promise((resolve) => disabled.server.close(resolve)); }

  const fixture = setup({ maxConnections: 1 });
  const admin = fixture.auth.login({ username: "admin", password: "admin-pass", ip: "127.0.0.1" });
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    const first = await openSse(fixture.server, "/api/browser-notifications/events", { Cookie: `ht_session=${admin.sessionId}` });
    const second = await jsonRequest(fixture.server, "GET", "/api/browser-notifications/events", { Cookie: `ht_session=${admin.sessionId}` });
    assert.equal(second.status, 503);
    first.req.destroy();
    await waitForClose(fixture.hub);
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});

test("heartbeat encerra SSE quando a sessão ADMIN é invalidada", async () => {
  const fixture = setup({ heartbeatMs: 10 });
  const admin = fixture.auth.login({ username: "admin", password: "admin-pass", ip: "127.0.0.1" });
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  try {
    const open = await openSse(fixture.server, "/api/browser-notifications/events", { Cookie: `ht_session=${admin.sessionId}` });
    fixture.auth.logout(admin.sessionId);
    await waitForClose(fixture.hub);
    open.req.destroy();
  } finally { await new Promise((resolve) => fixture.server.close(resolve)); }
});
