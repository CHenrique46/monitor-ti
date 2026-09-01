const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createWallpaperExecutor, ASSET_ID, EXTENSION } = require("./src/wallpaper");
const { createRemoteActionRuntime } = require("./src/remoteActions");

function jpeg(size = 32, fill = 7) {
  const body = Buffer.alloc(size, fill);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[size - 2] = 0xff;
  body[size - 1] = 0xd9;
  return body;
}

function sha256(body) {
  return crypto.createHash("sha256").update(body).digest("hex").toUpperCase();
}

function payload(url = "http://server.test:4000/api/assets/wallpaper/current?token=t&actionExecutionId=a&assetId=official-wallpaper-v1", body = jpeg()) {
  return { actionExecutionId: "a", assetId: ASSET_ID, downloadUrl: url, expectedSha256: sha256(body), expectedSize: body.length, extension: EXTENSION };
}

test("wallpaper rejeita URL inválida ou host diferente", async () => {
  const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: path.join(os.tmpdir(), "mti-wallpaper-invalid"), fetch: async () => { throw new Error("não deveria baixar"); } });
  await assert.rejects(() => exec(payload("http://evil.test/api/assets/wallpaper/current?token=t&actionExecutionId=a&assetId=official-wallpaper-v1")), /Origem/);
  await assert.rejects(() => exec(payload("http://server.test:4000/other?token=t&actionExecutionId=a&assetId=official-wallpaper-v1")), /URL/);
});

test("wallpaper baixa, valida, aplica e reaproveita cache válido", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-"));
  const body = jpeg();
  const expectedSha256 = sha256(body);
  let downloads = 0;
  let applied = 0;
  const exec = createWallpaperExecutor({
    serverUrl: "ws://server.test:4000", rootDir: root,
    getDeviceId: () => "device-expected",
    fetch: async (_url, options) => { assert.equal(options.headers["x-monitor-device-id"], "device-expected"); downloads++; return { ok: true, arrayBuffer: async () => body }; },
    applyWallpaper: null
  });
  const apply = async (request) => { applied++; assert.equal(request.style, "fill"); return { applied: true, username: "tester", sid: "S-1" }; };
  const command = payload(undefined, body);
  assert.equal(command.expectedSha256, expectedSha256);
  const first = await exec(command, apply);
  const second = await exec(command, apply);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(downloads, 1);
  assert.equal(applied, 2);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("wallpaper falha em timeout sem aplicar", async () => {
  const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: path.join(os.tmpdir(), "mti-wallpaper-timeout"), getDeviceId: () => "device-timeout", downloadTimeoutMs: 10, fetch: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
  await assert.rejects(() => exec(payload()), /Timeout/);
});

test("wallpaper exige metadata dinâmica válida antes do download", async () => {
  const body = jpeg();
  const valid = payload(undefined, body);
  const cases = [
    { ...valid, expectedSha256: undefined },
    { ...valid, expectedSize: undefined },
    { ...valid, expectedSha256: "bad" },
    { ...valid, expectedSize: 0 },
    { ...valid, expectedSize: 11 * 1024 * 1024 }
  ];
  for (const command of cases) {
    let downloads = 0;
    const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-metadata-")), getDeviceId: () => "device-1", fetch: async () => { downloads++; return { ok: true, arrayBuffer: async () => body }; } });
    await assert.rejects(() => exec(command), /Metadados|inválido|Hash|Tamanho/);
    assert.equal(downloads, 0);
  }
  for (const command of [{ ...valid, expectedSha256: "B".repeat(64) }, { ...valid, expectedSize: valid.expectedSize + 1 }]) {
    let downloads = 0;
    const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-metadata-mismatch-")), getDeviceId: () => "device-1", fetch: async () => { downloads++; return { ok: true, arrayBuffer: async () => body }; } });
    await assert.rejects(() => exec(command), /Hash|Tamanho/);
    assert.equal(downloads, 1);
  }
});

test("wallpaper rejeita conteúdo não JPEG e não chama companion", async () => {
  const body = Buffer.from("not-a-jpeg");
  const command = payload(undefined, body);
  let applied = 0;
  const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-format-")), getDeviceId: () => "device-1", fetch: async () => ({ ok: true, arrayBuffer: async () => body }) });
  await assert.rejects(() => exec(command, async () => { applied++; }), /Formato/);
  assert.equal(applied, 0);
});

test("cache de versão antiga é baixado novamente", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-cache-version-"));
  const oldBody = jpeg(30, 1);
  const newBody = jpeg(31, 2);
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.writeFile(path.join(root, "WallPaperVava.jpg"), oldBody);
  let downloads = 0;
  const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: root, getDeviceId: () => "device-1", fetch: async () => { downloads++; return { ok: true, arrayBuffer: async () => newBody }; } });
  const result = await exec(payload(undefined, newBody), async () => ({ applied: true }));
  assert.equal(result.cached, false);
  assert.equal(downloads, 1);
  await fs.promises.rm(root, { recursive: true, force: true });
});

test("wallpaper exige getDeviceId e não aceita deps.deviceId", async () => {
  let fetches = 0;
  const exec = createWallpaperExecutor({
    serverUrl: "ws://server.test:4000", rootDir: path.join(os.tmpdir(), "mti-wallpaper-device-required"), deviceId: "wrong-device",
    fetch: async () => { fetches++; return { ok: true }; }
  });
  await assert.rejects(() => exec(payload()), /Metadados|deviceId do Agent indisponível/);
  assert.equal(fetches, 0);
});

test("wallpaper falha fechado para deviceId vazio, getter ausente ou getter com erro", async () => {
  for (const getDeviceId of [() => "", () => "   ", () => { throw new Error("config indisponível"); }]) {
    let fetches = 0;
    let applied = 0;
    const exec = createWallpaperExecutor({
      serverUrl: "ws://server.test:4000", rootDir: await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-device-invalid-")), getDeviceId,
      fetch: async () => { fetches++; return { ok: true }; }
    });
    await assert.rejects(() => exec(payload(), async () => { applied++; }), /deviceId/);
    assert.equal(fetches, 0);
    assert.equal(applied, 0);
  }
});

test("set_wallpaper passa pelo handler allowlisted e propaga sucesso ou falha do companion", async () => {
  const command = payload();
  const ws = { readyState: 1, sent: [], send(value) { this.sent.push(JSON.parse(value)); } };
  const success = createRemoteActionRuntime({ executeWallpaper: async () => ({ applied: true, sid: "S-1" }), getDeviceId: () => "d1" });
  const result = await success.handleRemoteAction(ws, { actionExecutionId: "a", action: "set_wallpaper", payload: command });
  assert.equal(result.status, "SUCCESS");
  assert.equal(ws.sent.at(-1).result.applied, true);
  const failure = createRemoteActionRuntime({ executeWallpaper: async () => { throw new Error("Companion indisponível."); } });
  const failed = await failure.handleRemoteAction({ readyState: 1, send() {} }, { actionExecutionId: "b", action: "set_wallpaper", payload: command });
  assert.equal(failed.status, "FAILED");
});
