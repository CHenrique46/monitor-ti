const test = require("node:test");
const assert = require("node:assert/strict");
const { compareVersion, buildUpdateCommand } = require("../server/src/services/updateCommand");

const release = { version: "1.1.29", packageName: "MonitorTI-Agent-1.1.29-agent-only.zip", packageSha256: "a".repeat(64), packageSize: 123, packageMode: "agent-only", manifest: { schemaVersion: 1, version: "1.1.29", packageMode: "agent-only", files: [{ name: "MonitorTI-Agent.exe", sha256: "b".repeat(64), size: 456 }] } };
for (const current of ["1.1.23", "1.1.25", "1.1.26", "1.1.27", "1.1.28"]) test(`upgrade ${current} -> 1.1.29 usa somente o pacote Agent-only`, () => { const command = buildUpdateCommand(current, release); assert.equal(command.package, true); assert.equal(command.notifierSha256 || null, null); });
test("versão igual e downgrade são bloqueados antes do envio", () => { assert.equal(compareVersion("1.1.29", release.version) >= 0, true); assert.equal(compareVersion("1.1.30", release.version) >= 0, true); assert.equal(compareVersion("1.1.28", release.version) < 0, true); });
