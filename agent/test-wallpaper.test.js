const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWallpaperExecutor, SHA256, SIZE } = require("./src/wallpaper");
const { createRemoteActionRuntime } = require("./src/remoteActions");

function payload(url = "http://server.test:4000/api/assets/wallpaper/current?token=t&actionExecutionId=a&assetId=official-wallpaper-v1") {
  return { actionExecutionId: "a", assetId: "official-wallpaper-v1", downloadUrl: url, sha256: SHA256, size: SIZE, extension: ".jpg" };
}

test("wallpaper rejeita URL inválida ou host diferente", async () => {
  const exec = createWallpaperExecutor({ serverUrl: "ws://server.test:4000", rootDir: path.join(os.tmpdir(), "mti-wallpaper-invalid"), fetch: async () => { throw new Error("não deveria baixar"); } });
  await assert.rejects(() => exec(payload("http://evil.test/api/assets/wallpaper/current?token=t&actionExecutionId=a&assetId=official-wallpaper-v1")), /Origem/);
  await assert.rejects(() => exec(payload("http://server.test:4000/other?token=t&actionExecutionId=a&assetId=official-wallpaper-v1")), /URL/);
});

test("wallpaper baixa, valida, aplica e reaproveita cache válido", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-wallpaper-"));
  const body = Buffer.alloc(SIZE, 7);
  let downloads = 0;
  let applied = 0;
  const exec = createWallpaperExecutor({
    serverUrl: "ws://server.test:4000", rootDir: root,
    getDeviceId: () => "device-expected",
    fetch: async (_url, options) => { assert.equal(options.headers["x-monitor-device-id"], "device-expected"); downloads++; return { ok: true, arrayBuffer: async () => body }; },
    sha256File: async () => SHA256,
    applyWallpaper: null
  });
  const apply = async (request) => { applied++; assert.equal(request.style, "fill"); return { applied: true, username: "tester", sid: "S-1" }; };
  const first = await exec(payload(), apply);
  const second = await exec(payload(), apply);
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

test("wallpaper exige getDeviceId e não aceita deps.deviceId", async () => {
  let fetches = 0;
  const exec = createWallpaperExecutor({
    serverUrl: "ws://server.test:4000", rootDir: path.join(os.tmpdir(), "mti-wallpaper-device-required"), deviceId: "wrong-device",
    fetch: async () => { fetches++; return { ok: true }; }
  });
  await assert.rejects(() => exec(payload()), /deviceId do Agent indisponível/);
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
