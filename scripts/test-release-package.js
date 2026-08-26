// Testes isolados do suporte a release multi-arquivo (1.1.0) no servidor.
// NÃO toca no servidor em execução; importa os módulos diretamente.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const releasesService = require("../server/src/services/releases.service");
const { buildUpdateCommand, compareVersion } = require("../server/src/services/updateCommand");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? " :: " + extra : "")); }
}
function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

async function main() {
  // 1) 1.0.1 (legada) expõe campos de pacote nulos.
  const legacy = await releasesService.getRelease("1.0.1");
  const legacyPub = releasesService.toPublic(legacy);
  check("legacy.1.0.1 exists", !!legacy);
  check("legacy packageName null", legacyPub.packageName === null, JSON.stringify(legacyPub.packageName));
  check("legacy packageSha256 null", legacyPub.packageSha256 === null);
  check("legacy manifest null", legacyPub.manifest === null);
  check("legacy has agent sha", !!legacyPub.sha256 && legacyPub.size > 0);

  // 2) 1.0.0 também legada e baixável.
  const v00 = await releasesService.getRelease("1.0.0");
  check("1.0.0 exists", !!v00);
  check("1.0.0 legacy (no package)", releasesService.toPublic(v00).packageName === null);

  // 3) 1.1.0 multi-arquivo expõe pacote + manifest.
  const r = await releasesService.getRelease("1.1.0");
  check("1.1.0 exists", !!r);
  const pub = releasesService.toPublic(r);
  check("1.1.0 packageName set", !!pub.packageName, pub.packageName);
  check("1.1.0 packageSha256 set", !!pub.packageSha256, pub.packageSha256);
  check("1.1.0 packageSize > 0", pub.packageSize > 0, "" + pub.packageSize);
  check("1.1.0 manifest present", !!pub.manifest && Array.isArray(pub.manifest.files) && pub.manifest.files.length === 2);
  const agentInMan = pub.manifest.files.find((f) => f.name === "MonitorTI-Agent.exe");
  const notifInMan = pub.manifest.files.find((f) => f.name === "MonitorTI-Notifier.exe");
  check("manifest has Agent", !!agentInMan);
  check("manifest has Notifier", !!notifInMan && !!notifInMan.sha256, notifInMan && notifInMan.sha256);

  // 4) Release ativa continua sendo 1.0.1 (1.1.0 INATIVA).
  const active = await releasesService.getActiveRelease();
  check("active is 1.0.1 (1.1.0 nao ativada)", active && active.version === "1.0.1", active && active.version);

  // 5) resolveFile: proteção contra traversal e allowlist.
  check("resolveFile ok (manifest)", releasesService.resolveFile("1.1.0", "manifest.json") !== null);
  check("resolveFile ok (zip)", releasesService.resolveFile("1.1.0", pub.packageName) !== null);
  check("resolveFile block traversal", releasesService.resolveFile("1.1.0", "../1.0.1/MonitorTI-Agent.exe") === null);
  check("resolveFile block absolute", releasesService.resolveFile("1.1.0", "C:\\Windows\\System32\\calc.exe") === null);
  check("resolveFile block subdir", releasesService.resolveFile("1.1.0", "sub/manifest.json") === null);
  check("resolveFile block bad version", releasesService.resolveFile("../1.1.0", "manifest.json") === null);

  // 6) Pacote: SHA do zip confere com o banco e arquivos extraídos conferem com o manifest.
  const zipPath = releasesService.resolveFile("1.1.0", pub.packageName);
  check("zip file exists", fs.existsSync(zipPath));
  const zipSha = sha256File(zipPath);
  check("zip sha == DB packageSha256", zipSha.toLowerCase() === String(pub.packageSha256).toLowerCase(), zipSha + " vs " + pub.packageSha256);
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "mti-pkg-"));
  const out = path.join(tmp, "out");
  fs.mkdirSync(out, { recursive: true });
  const t = spawnSync("tar", ["-xf", zipPath, "-C", out], { windowsHide: true });
  check("tar extract ok", t.status === 0, t.stderr && t.stderr.toString());
  const manOnDisk = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
  for (const f of manOnDisk.files) {
    const fp = path.join(out, f.name);
    check("pkg file present: " + f.name, fs.existsSync(fp));
    const actualSha = sha256File(fp);
    check("pkg sha ok: " + f.name, actualSha.toLowerCase() === String(f.sha256).toLowerCase(), actualSha + " vs " + f.sha256);
    check("pkg size ok: " + f.name, fs.statSync(fp).size === f.size, fs.statSync(fp).size + " vs " + f.size);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

  // 7) buildUpdateCommand: 1.0.1 -> legado (sem package).
  const cmdLegacy = buildUpdateCommand("1.0.1", r);
  check("1.0.1 legado sem package", cmdLegacy.package !== true);
  check("1.0.1 legado usa sha do agent", cmdLegacy.sha256 === r.sha256);

  // 8) buildUpdateCommand: 1.1.0 -> pacote com notifierSha.
  const cmdPkg = buildUpdateCommand("1.1.0", r);
  check("1.1.0 usa pacote", cmdPkg.package === true);
  check("1.1.0 sha do pacote", cmdPkg.sha256 === r.packageSha256);
  check("1.1.0 notifierSha informado", cmdPkg.notifierSha256 && cmdPkg.notifierSha256 === notifInMan.sha256, cmdPkg.notifierSha256);

  // 9) buildUpdateCommand: release sem pacote -> sempre legado, mesmo p/ 1.1.0.
  const noPkg = Object.assign({}, r, { packageName: null, packageSha256: null, packageSize: null });
  const cmdSafe = buildUpdateCommand("1.1.0", noPkg);
  check("release sem pacote -> legado", cmdSafe.package !== true);

  // 10) compareVersion helper.
  check("compareVersion 1.0.1 < 1.1.0", compareVersion("1.0.1", "1.1.0") < 0);
  check("compareVersion equal", compareVersion("1.1.0", "1.1.0") === 0);

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("ERRO no teste:", e); process.exit(1); });
