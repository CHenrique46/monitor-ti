const test = require("node:test");
const assert = require("node:assert/strict");
const { createWallpaperAssetService, ASSET_ID, ASSET_SHA256, ASSET_SIZE, TOKEN_TTL_MS } = require("./src/services/wallpaperAsset.service");
const { createRemoteActionsController } = require("./src/controllers/remoteActions.controller");

const asset = "C:\\DskBackground\\WallPaperVava.jpg";
function assetDeps(now = 1000, hash = ASSET_SHA256) {
  return { assetPath: asset, now: () => now, statImpl: () => ({ isFile: () => true, size: ASSET_SIZE }), hashImpl: () => hash };
}

test("asset oficial rejeita inexistente e hash divergente", () => {
  assert.throws(() => createWallpaperAssetService({ ...assetDeps(), statImpl: () => { throw new Error("missing"); } }).validate(), /não encontrado/);
  assert.throws(() => createWallpaperAssetService({ ...assetDeps(), hashImpl: () => "bad" }).validate(), /Hash/);
});

test("token de wallpaper é efêmero, vinculado e não aceita asset arbitrário", () => {
  let now = 1000;
  const service = createWallpaperAssetService({ ...assetDeps(), now: () => now });
  const issued = service.issueDownloadToken({ actionExecutionId: "a1", deviceId: "d1" });
  assert.equal(issued.asset.assetId, ASSET_ID);
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d1", assetId: ASSET_ID }).ok, true);
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d2", assetId: ASSET_ID }).status, 403);
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d1", assetId: "other" }).status, 403);
  now += TOKEN_TTL_MS + 1;
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d1", assetId: ASSET_ID }).status, 403);
});

test("set_wallpaper cria ação somente com payload controlado e rejeita offline", async () => {
  const executions = [];
  const db = {
    computador: { findUnique: async () => ({ id: 2, deviceId: "d2", hostname: "PC-2", status: "offline" }) },
    acaoRemotaExecucao: {
      create: async ({ data }) => { const e = { ...data, id: 1, status: "PENDING" }; executions.push(e); return e; },
      updateMany: async ({ data }) => { Object.assign(executions[0], data, { status: "REJECTED" }); return { count: 1 }; },
      findUnique: async () => executions[0]
    }
  };
  const service = { validate: () => true, issueDownloadToken: () => { throw new Error("não deveria emitir token"); }, createExecution: async ({ computadorId, action }) => { assert.equal(computadorId, 2); assert.equal(action, "set_wallpaper"); const e = await db.acaoRemotaExecucao.create({ data: { actionExecutionId: "a1", computadorId, action, payload: null } }); return e; }, markRejected: async () => true, getByActionExecutionId: async () => executions[0] };
  const controller = createRemoteActionsController({ prisma: db, remoteActionsService: service, wallpaperAssetService: { validate: () => true } });
  const res = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.setWallpaper({ params: { id: 2 } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(executions[0].payload, null);
});

test("set_wallpaper envia somente asset fixo, hash e URL tokenizada", async () => {
  const previousUrl = process.env.AGENT_SERVER_PUBLIC_URL;
  process.env.AGENT_SERVER_PUBLIC_URL = "http://192.168.40.133:4000";
  const sent = [];
  const db = {
    computador: { findUnique: async () => ({ id: 1, deviceId: "d1", hostname: "PC-1", status: "online" }) },
    acaoRemotaExecucao: { create: async ({ data }) => ({ ...data, id: 1, status: "PENDING" }), updateMany: async () => ({ count: 1 }), findUnique: async () => ({ actionExecutionId: "a1", action: "set_wallpaper", status: "DISPATCHED" }) }
  };
  const service = { validate: () => true, issueDownloadToken: () => ({ token: "opaque", asset: { assetId: ASSET_ID, sha256: ASSET_SHA256, size: ASSET_SIZE, extension: ".jpg" } }), createExecution: async () => ({ actionExecutionId: "a1" }), markDispatched: async () => true, getByActionExecutionId: async () => ({ actionExecutionId: "a1", status: "DISPATCHED" }) };
  const controller = createRemoteActionsController({ prisma: db, remoteActionsService: service, agentServer: { sendToAgent: (deviceId, message) => { sent.push({ deviceId, message }); return true; } }, wallpaperAssetService: service });
  const res = { statusCode: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.setWallpaper({ params: { id: 1 }, protocol: "http", get: () => "server.test:4000" }, res);
  if (previousUrl === undefined) delete process.env.AGENT_SERVER_PUBLIC_URL;
  else process.env.AGENT_SERVER_PUBLIC_URL = previousUrl;
  assert.equal(res.statusCode, 202);
  const payload = sent[0].message.payload;
  assert.deepEqual(Object.keys(payload).sort(), ["actionExecutionId", "assetId", "downloadUrl", "extension", "sha256", "size"].sort());
  assert.equal(payload.assetId, ASSET_ID);
  assert.equal(payload.sha256, ASSET_SHA256);
  assert.equal(payload.size, ASSET_SIZE);
  assert.equal(payload.downloadUrl.includes("token=opaque"), true);
  assert.equal(payload.downloadUrl.includes("DskBackground"), false);
});
