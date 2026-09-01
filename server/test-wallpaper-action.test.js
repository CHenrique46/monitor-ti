const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createWallpaperAssetService, ASSET_ID, TOKEN_TTL_MS } = require("./src/services/wallpaperAsset.service");
const { createWallpaperAssetController } = require("./src/controllers/wallpaperAsset.controller");
const { createRemoteActionsController } = require("./src/controllers/remoteActions.controller");

const asset = "C:\\DskBackground\\WallPaperVava.jpg";
function jpeg(fill = 7, size = 32) {
  const body = Buffer.alloc(size, fill);
  body[0] = 0xff; body[1] = 0xd8; body[2] = 0xff;
  body[size - 2] = 0xff; body[size - 1] = 0xd9;
  return body;
}
function digest(body) {
  return crypto.createHash("sha256").update(body).digest("hex").toUpperCase();
}
function assetDeps(body = jpeg(), now = 1000) {
  return { assetPath: asset, now: () => now, readFileImpl: () => body };
}

test("asset oficial calcula SHA/tamanho dinamicamente e rejeita ausente/formato inválido", () => {
  const body = jpeg(3, 41);
  const service = createWallpaperAssetService(assetDeps(body));
  const metadata = service.validate();
  assert.equal(metadata.size, body.length);
  assert.equal(metadata.sha256, digest(body));
  assert.equal(metadata.extension, ".jpg");
  assert.throws(() => createWallpaperAssetService({ ...assetDeps(), readFileImpl: () => { throw new Error("missing"); } }).validate(), /não encontrado/);
  assert.throws(() => createWallpaperAssetService({ ...assetDeps(Buffer.from("not-jpeg")) }).validate(), /Formato/);
  assert.throws(() => createWallpaperAssetService({ ...assetDeps(body), assetPath: "C:\\DskBackground\\WallPaperVava.png" }).validate(), /JPG/);
});

test("nova imagem com mesmo nome gera novos metadados sem alterar código", () => {
  const first = jpeg(1, 32);
  const second = jpeg(2, 47);
  const service = createWallpaperAssetService(assetDeps(second));
  const issued = service.issueDownloadToken({ actionExecutionId: "a1", deviceId: "d1" });
  assert.notEqual(issued.asset.sha256, digest(first));
  assert.equal(issued.asset.sha256, digest(second));
  assert.equal(issued.asset.size, second.length);
});

test("token armazena metadados, é efêmero e vincula ação/device/asset", () => {
  let now = 1000;
  const body = jpeg();
  const service = createWallpaperAssetService({ ...assetDeps(body), now: () => now });
  const issued = service.issueDownloadToken({ actionExecutionId: "a1", deviceId: "d1" });
  assert.equal(issued.asset.assetId, ASSET_ID);
  assert.equal(issued.asset.sha256, digest(body));
  assert.equal(issued.asset.size, body.length);
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d1", assetId: ASSET_ID }).asset.sha256, digest(body));
  assert.equal(service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d2", assetId: ASSET_ID }).status, 403);
  const issued2 = service.issueDownloadToken({ actionExecutionId: "a2", deviceId: "d1" });
  assert.equal(service.consumeDownloadToken({ token: issued2.token, actionExecutionId: "wrong", deviceId: "d1", assetId: ASSET_ID }).status, 403);
  now += TOKEN_TTL_MS + 1;
  assert.equal(service.consumeDownloadToken({ token: issued2.token, actionExecutionId: "a2", deviceId: "d1", assetId: ASSET_ID }).status, 403);
});

test("troca do arquivo após emissão falha sem enviar bytes diferentes", () => {
  const oldBody = jpeg(1, 32);
  const newBody = jpeg(2, 33);
  let current = oldBody;
  const service = createWallpaperAssetService({ ...assetDeps(oldBody), readFileImpl: () => current });
  const issued = service.issueDownloadToken({ actionExecutionId: "a1", deviceId: "d1" });
  current = newBody;
  const result = service.consumeDownloadToken({ token: issued.token, actionExecutionId: "a1", deviceId: "d1", assetId: ASSET_ID });
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /alterado/);
  assert.equal(result.asset, undefined);
  current = oldBody;
  const issued2 = service.issueDownloadToken({ actionExecutionId: "a2", deviceId: "d1" });
  current = newBody;
  let sent = false;
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() {}, set() { return this; }, end() { sent = true; } };
  createWallpaperAssetController({ service }).download({ query: { token: issued2.token, actionExecutionId: "a2", assetId: ASSET_ID }, get: () => "d1" }, response);
  assert.equal(response.statusCode, 409);
  assert.equal(sent, false);
});

test("endpoint envia exatamente o Buffer validado e rejeita token expirado", () => {
  const body = jpeg(4, 36);
  let now = 1000;
  const service = createWallpaperAssetService({ ...assetDeps(body), now: () => now });
  const issued = service.issueDownloadToken({ actionExecutionId: "a1", deviceId: "d1" });
  const sent = [];
  const response = { headers: {}, statusCode: 200, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; }, end(value) { sent.push(value); return this; } };
  const controller = createWallpaperAssetController({ service });
  controller.download({ query: { token: issued.token, actionExecutionId: "a1", assetId: ASSET_ID }, get: () => "d1" }, response);
  assert.deepEqual(sent[0], body);
  const issued2 = service.issueDownloadToken({ actionExecutionId: "a2", deviceId: "d1" });
  now += TOKEN_TTL_MS + 1;
  const expired = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  controller.download({ query: { token: issued2.token, actionExecutionId: "a2", assetId: ASSET_ID }, get: () => "d1" }, expired);
  assert.equal(expired.statusCode, 403);
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
   const service = { validate: () => true, issueDownloadToken: () => ({ token: "opaque", asset: { assetId: ASSET_ID, sha256: digest(jpeg()), size: 32, extension: ".jpg" } }), createExecution: async () => ({ actionExecutionId: "a1" }), markDispatched: async () => true, getByActionExecutionId: async () => ({ actionExecutionId: "a1", status: "DISPATCHED" }) };
  const controller = createRemoteActionsController({ prisma: db, remoteActionsService: service, agentServer: { sendToAgent: (deviceId, message) => { sent.push({ deviceId, message }); return true; } }, wallpaperAssetService: service });
  const res = { statusCode: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await controller.setWallpaper({ params: { id: 1 }, protocol: "http", get: () => "server.test:4000" }, res);
  if (previousUrl === undefined) delete process.env.AGENT_SERVER_PUBLIC_URL;
  else process.env.AGENT_SERVER_PUBLIC_URL = previousUrl;
  assert.equal(res.statusCode, 202);
  const payload = sent[0].message.payload;
  assert.deepEqual(Object.keys(payload).sort(), ["actionExecutionId", "assetId", "downloadUrl", "extension", "expectedSha256", "expectedSize"].sort());
  assert.equal(payload.assetId, ASSET_ID);
   assert.equal(payload.expectedSha256, digest(jpeg()));
   assert.equal(payload.expectedSize, 32);
  assert.equal(payload.downloadUrl.includes("token=opaque"), true);
  assert.equal(payload.downloadUrl.includes("DskBackground"), false);
});
