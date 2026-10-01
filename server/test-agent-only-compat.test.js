const test = require("node:test");
const assert = require("node:assert/strict");

const releases = require("./src/services/releases.service");
const { buildUpdateCommand, compareVersion } = require("./src/services/updateCommand");
const controller = require("./src/controllers/agentUpdate.controller");

const HASH = (char) => char.repeat(64);

function manifest(packageMode, files) {
  return { version: "1.1.26", packageMode, files };
}

function agentOnlyRelease() {
  return {
    id: 26,
    version: "1.1.26",
    packageMode: "agent-only",
    packageName: "MonitorTI-Agent-1.1.26-agent-only.zip",
    packageSha256: HASH("a"),
    packageSize: 100,
    manifest: manifest("agent-only", [{ name: "MonitorTI-Agent.exe", sha256: HASH("b"), size: 100 }])
  };
}

function fullRelease() {
  return {
    ...agentOnlyRelease(),
    packageMode: "full",
    manifest: manifest("full", [
      { name: "MonitorTI-Agent.exe", sha256: HASH("b"), size: 100 },
      { name: "MonitorTI-Notifier.exe", sha256: HASH("c"), size: 50 },
      { name: "notifier-integrity.json", sha256: HASH("d"), size: 1 }
    ])
  };
}

test("manifestos full e agent-only válidos", () => {
  assert.equal(releases.validatePackageManifest(agentOnlyRelease()), true);
  assert.equal(releases.validatePackageManifest(fullRelease()), true);
});

test("manifesto rejeita arquivos ausentes, proibidos ou desconhecidos", () => {
  const agent = agentOnlyRelease();
  assert.equal(releases.validatePackageManifest({ ...agent, manifest: manifest("agent-only", []) }), false);
  assert.equal(releases.validatePackageManifest({ ...agent, manifest: manifest("agent-only", [{ name: "MonitorTI-Agent.exe", sha256: HASH("b"), size: 1 }, { name: "MonitorTI-Notifier.exe", sha256: HASH("c"), size: 1 }]) }), false);
  assert.equal(releases.validatePackageManifest({ ...agent, manifest: manifest("agent-only", [{ name: "MonitorTI-Agent.exe", sha256: HASH("b"), size: 1 }, { name: "unknown.bin", sha256: HASH("c"), size: 1 }]) }), false);
  const full = fullRelease();
  assert.equal(releases.validatePackageManifest({ ...full, manifest: manifest("full", full.manifest.files.filter((file) => file.name !== "MonitorTI-Notifier.exe")) }), false);
  assert.equal(releases.validatePackageManifest({ ...full, manifest: manifest("full", full.manifest.files.filter((file) => file.name !== "notifier-integrity.json")) }), false);
});

test("comando Agent-only não contém campos do Notifier", () => {
  const command = buildUpdateCommand("1.1.25", agentOnlyRelease());
  assert.deepEqual(command, {
    type: "update_agent",
    currentVersion: "1.1.25",
    version: "1.1.26",
    sha256: HASH("a"),
    size: 100,
    package: true,
    packageMode: "agent-only"
  });
  assert.equal(Object.prototype.hasOwnProperty.call(command, "notifierSha256"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(buildUpdateCommand("1.1.25", fullRelease()), "notifierSha256"), true);
});

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

async function triggerFor(computer, release) {
  const sent = [];
  const db = {
    computador: { findUnique: async () => computer },
    agentUpdate: { create: async ({ data }) => ({ id: 1, ...data }) }
  };
  const res = response();
  await controller.trigger({ params: { id: "1" }, body: { version: release.version }, humanUser: { username: "test" } }, res, {
    prisma: db,
    releasesService: { getRelease: async () => release, hasArtifact: () => true },
    agentServer: { sendToAgent: (deviceId, command) => { sent.push({ deviceId, command }); return true; } }
  });
  return { res, sent };
}

test("controller aceita Agent-only somente para upgrade estável online", async () => {
  const release = agentOnlyRelease();
  const good = await triggerFor({ id: 1, deviceId: "d", hostname: "pc", agentVersion: "1.1.25", status: "online" }, release);
  assert.equal(good.res.code, 202);
  assert.equal(good.sent[0].deviceId, "d");
  assert.equal(good.sent[0].command.packageMode, "agent-only");
  assert.equal(Object.prototype.hasOwnProperty.call(good.sent[0].command, "notifierSha256"), false);
  for (const computer of [
    { agentVersion: "1.1.26", status: "online" },
    { agentVersion: "1.1.27", status: "online" },
    { agentVersion: "1.1.19-dev", status: "online" },
    { agentVersion: "invalid", status: "online" },
    { agentVersion: "1.1.25", status: "offline" }
  ]) {
    const result = await triggerFor({ id: 1, deviceId: "d", hostname: "pc", ...computer }, release);
    assert.equal(result.res.code, 409);
    assert.equal(result.sent.length, 0);
  }
});

test("release inativa só é disparada explicitamente para fiscal77", async () => {
  const release = { ...agentOnlyRelease(), version: "1.1.30", active: false, manifest: { ...agentOnlyRelease().manifest, version: "1.1.30" } };
  const target = await triggerFor({ id: 77, deviceId: "fiscal77-device", hostname: "fiscal77", equipamentoNumero: "77", agentVersion: "1.1.29", status: "online" }, release);
  assert.equal(target.res.code, 202);
  assert.equal(target.sent[0].deviceId, "fiscal77-device");

  const otherDb = {
    computador: { findUnique: async () => ({ id: 12, deviceId: "other-device", hostname: "other", agentVersion: "1.1.29", status: "online" }) },
    agentUpdate: { create: async () => ({ id: 1 }) }
  };
  const otherRes = response();
  const sent = [];
  await controller.trigger({ params: { id: "12" }, body: {}, humanUser: { username: "test" } }, otherRes, {
    prisma: otherDb,
    releasesService: { getActiveRelease: async () => null, hasArtifact: () => true },
    agentServer: { sendToAgent: (...args) => sent.push(args) }
  });
  assert.equal(otherRes.code, 409);
  assert.equal(sent.length, 0);
});

test("parser aceita somente versões estáveis", () => {
  assert.deepEqual(compareVersion("1.1.25", "1.1.26"), -1);
  assert.equal(compareVersion("1.1.19-dev", "1.1.26"), null);
  assert.equal(compareVersion("", "1.1.26"), null);
  assert.equal(compareVersion("1.1", "1.1.26"), null);
});
