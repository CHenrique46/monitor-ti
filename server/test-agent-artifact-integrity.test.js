const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const releases = require("./src/services/releases.service");

const VERSION = "9.9.91";
const releaseDir = path.join(releases.RELEASES_ROOT, VERSION);
const packageName = "MonitorTI-Agent-package.zip";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifest(packageMode) {
  const files = packageMode === "full"
    ? [
      { name: "MonitorTI-Agent.exe", sha256: "a".repeat(64), size: 10 },
      { name: "MonitorTI-Notifier.exe", sha256: "b".repeat(64), size: 10 },
      { name: "notifier-integrity.json", sha256: "c".repeat(64), size: 10 }
    ]
    : [{ name: "MonitorTI-Agent.exe", sha256: "a".repeat(64), size: 10 }];
  return { version: VERSION, packageMode, files };
}

function response() {
  const listeners = new Map();
  return {
    downloads: [],
    once(event, handler) { listeners.set(event, handler); },
    emit(event) { const handler = listeners.get(event); if (handler) handler(); },
    download(filePath, fileName, callback) {
      this.downloads.push({ filePath, fileName, tempPath: filePath });
      this.downloadCallback = callback;
    }
  };
}

async function settleCleanup() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function packageRelease(packageMode, bytes) {
  return {
    version: VERSION,
    packageName,
    packageSha256: sha256(bytes),
    packageSize: bytes.length,
    packageMode,
    manifest: manifest(packageMode)
  };
}

test.before(() => {
  fs.mkdirSync(releaseDir, { recursive: true });
});

test.after(() => {
  fs.rmSync(releaseDir, { recursive: true, force: true });
});

test("streamPackage valida manifesto e integridade nos modos full e agent-only", async () => {
  for (const packageMode of ["full", "agent-only"]) {
    const bytes = Buffer.from(`valid-${packageMode}`);
    fs.writeFileSync(path.join(releaseDir, packageName), bytes);
    const release = packageRelease(packageMode, bytes);
    const res = response();

    assert.equal(await releases.streamPackage(VERSION, res, { getRelease: async () => release }), true);
    assert.equal(res.downloads[0].fileName, packageName);
    res.downloadCallback();
    await settleCleanup();
    assert.equal(fs.existsSync(res.downloads[0].tempPath), false);
  }
});

test("artefato agent-only adulterado após cadastro não inicia stream nem passa em hasArtifact", async () => {
  const original = Buffer.from("registered-package");
  const release = packageRelease("agent-only", original);
  fs.writeFileSync(path.join(releaseDir, packageName), Buffer.from("tampered-package"));

  const res = response();
  assert.equal(await releases.hasArtifact(release, "1.1.90"), false);
  assert.equal(await releases.streamPackage(VERSION, res, { getRelease: async () => release }), false);
  assert.deepEqual(res.downloads, []);
});

test("manifesto full inválido não inicia stream", async () => {
  const bytes = Buffer.from("full-package");
  const release = packageRelease("full", bytes);
  release.manifest.files = release.manifest.files.slice(0, 2);
  fs.writeFileSync(path.join(releaseDir, packageName), bytes);

  const res = response();
  assert.equal(await releases.streamPackage(VERSION, res, { getRelease: async () => release }), false);
  assert.deepEqual(res.downloads, []);
});

test("streamRelease valida tamanho e hash do artefato legado antes de iniciar", async () => {
  const fileName = "MonitorTI-Agent.exe";
  const bytes = Buffer.from("legacy-agent");
  const release = {
    version: VERSION,
    fileName,
    sha256: sha256(bytes),
    size: bytes.length
  };
  fs.writeFileSync(path.join(releaseDir, fileName), bytes);
  const res = response();

  assert.equal(await releases.streamRelease(VERSION, res, { getRelease: async () => release }), true);
  assert.equal(res.downloads[0].fileName, fileName);
  res.emit("close");
  await settleCleanup();
  assert.equal(fs.existsSync(res.downloads[0].tempPath), false);

  fs.writeFileSync(path.join(releaseDir, fileName), Buffer.from("legacy-agent-tampered"));
  const tamperedRes = response();
  assert.equal(await releases.streamRelease(VERSION, tamperedRes, { getRelease: async () => release }), false);
  assert.deepEqual(tamperedRes.downloads, []);
});

test("falha de cópia não inicia stream e remove o temporário", async () => {
  const bytes = Buffer.from("copy-failure");
  const release = packageRelease("agent-only", bytes);
  fs.writeFileSync(path.join(releaseDir, packageName), bytes);
  const res = response();
  const result = await releases.streamPackage(VERSION, res, {
    getRelease: async () => release,
    copyFile: async () => { throw new Error("copy failed"); }
  });

  assert.equal(result, false);
  assert.deepEqual(res.downloads, []);
  assert.deepEqual(fs.readdirSync(releaseDir).filter((name) => name.startsWith(".agent-download-")), []);
});

test("substituição do original após a cópia não altera o arquivo servido", async () => {
  const original = Buffer.from("stable-copy");
  const release = packageRelease("agent-only", original);
  fs.writeFileSync(path.join(releaseDir, packageName), original);
  const res = response();
  const result = await releases.streamPackage(VERSION, res, {
    getRelease: async () => release,
    copyFile: async (source, target) => {
      await fs.promises.copyFile(source, target);
      fs.writeFileSync(source, Buffer.from("replaced-original"));
    }
  });

  assert.equal(result, true);
  assert.equal(fs.readFileSync(res.downloads[0].tempPath, "utf8"), "stable-copy");
  assert.equal(fs.readFileSync(path.join(releaseDir, packageName), "utf8"), "replaced-original");
  res.emit("close");
  await settleCleanup();
  assert.equal(fs.existsSync(res.downloads[0].tempPath), false);
});
