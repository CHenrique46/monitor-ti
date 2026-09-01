const test = require("node:test");
const assert = require("node:assert/strict");
const { getAgentServerPublicUrl } = require("./src/config");
const { createRemoteActionsController } = require("./src/controllers/remoteActions.controller");

function withUrl(value, fn) {
  const previous = process.env.AGENT_SERVER_PUBLIC_URL;
  if (value === undefined) delete process.env.AGENT_SERVER_PUBLIC_URL;
  else process.env.AGENT_SERVER_PUBLIC_URL = value;
  try { return fn(); } finally {
    if (previous === undefined) delete process.env.AGENT_SERVER_PUBLIC_URL;
    else process.env.AGENT_SERVER_PUBLIC_URL = previous;
  }
}

function makeController({ createCount = { value: 0 }, sent = [] } = {}) {
  const execution = { actionExecutionId: "url-test", action: "set_wallpaper", status: "DISPATCHED" };
  const db = { computador: { findUnique: async () => ({ id: 1, deviceId: "device-1", hostname: "PC-1", status: "online" }) } };
  const service = {
    validate: () => true,
    createExecution: async () => { createCount.value += 1; return execution; },
     issueDownloadToken: () => ({ token: "opaque", asset: { assetId: "official-wallpaper-v1", sha256: "A".repeat(64), size: 32, extension: ".jpg" } }),
    markDispatched: async () => true,
    getByActionExecutionId: async () => execution
  };
  return createRemoteActionsController({ prisma: db, remoteActionsService: service, wallpaperAssetService: service, agentServer: { sendToAgent: (deviceId, message) => { sent.push({ deviceId, message }); return true; } } });
}

function response() {
  return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

test("AGENT_SERVER_PUBLIC_URL válida e barra final são normalizadas", () => {
  withUrl("http://192.168.40.133:4000/", () => assert.equal(getAgentServerPublicUrl(), "http://192.168.40.133:4000"));
  withUrl("https://agents.example.test/base///", () => assert.equal(getAgentServerPublicUrl(), "https://agents.example.test/base"));
});

test("Host e protocolo do request não influenciam a URL pública do Agent", async () => {
  const sent = [];
  const controller = makeController({ sent });
  await withUrl("http://192.168.40.133:4000/", async () => {
    const res = response();
    await controller.setWallpaper({ params: { id: 1 }, protocol: "https", get: () => "evil.example:443" }, res);
    assert.equal(res.statusCode, 202);
  });
  assert.match(sent[0].message.payload.downloadUrl, /^http:\/\/192\.168\.40\.133:4000\/api\/assets\/wallpaper\/current/);
  assert.equal(sent[0].message.payload.downloadUrl.includes("evil.example"), false);
});

test("URL ausente ou inválida falha fechado antes de criar ação", async () => {
  for (const value of [undefined, "", "not-a-url", "ftp://192.168.40.133:4000", "http://user:pass@192.168.40.133:4000"]) {
    const count = { value: 0 };
    const controller = makeController({ createCount: count });
    await withUrl(value, async () => {
      const res = response();
      await controller.setWallpaper({ params: { id: 1 }, protocol: "http", get: () => "127.0.0.1:4000" }, res);
      assert.equal(res.statusCode, 503);
      assert.equal(count.value, 0);
    });
  }
});
