const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(file) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Get-FileHash -LiteralPath '${file.replace(/'/g, "''")}' -Algorithm SHA256 | Select-Object -ExpandProperty Hash`], { encoding: "utf8" }).trim().toLowerCase();
}

function main() {
  const pkgDir = path.join(__dirname, "..", "releases", "agent", "1.1.8");
  const zip = path.join(pkgDir, "MonitorTI-Agent-1.1.8.zip");
  const manifestPath = path.join(pkgDir, "manifest.json");

  check("PKG-001 zip existe", fs.existsSync(zip));
  check("PKG-002 manifest existe", fs.existsSync(manifestPath));

  const tarList = spawnSync("tar", ["-tf", zip], { encoding: "utf8" });
  check("PKG-003 zip legivel", tarList.status === 0, tarList.stderr || tarList.error && tarList.error.message);
  const entries = (tarList.stdout || "").split(/\r?\n/).filter(Boolean);
  check("PKG-004 sem traversal", !entries.some((e) => /^\//.test(e) || /(^|[\\/])\.\.([\\/]|$)/.test(e)));

  const extracted = tempDir("mti-pkg-");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${extracted.replace(/'/g, "''")}' -Force`], { stdio: "ignore" });

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const agent = path.join(pkgDir, "MonitorTI-Agent.exe");
  const not = path.join(pkgDir, "MonitorTI-Notifier.exe");
  check("PKG-005 manifest version", manifest.version === "1.1.8");
  check("PKG-006 sha agent", manifest.files.find((f) => f.name === "MonitorTI-Agent.exe").sha256 === sha256(agent));
  check("PKG-007 sha notifier", manifest.files.find((f) => f.name === "MonitorTI-Notifier.exe").sha256 === sha256(not));
  check("PKG-008 zip possui manifest", fs.existsSync(path.join(extracted, "manifest.json")));
  check("PKG-009 zip possui binaries", fs.existsSync(path.join(extracted, "MonitorTI-Agent.exe")) && fs.existsSync(path.join(extracted, "MonitorTI-Notifier.exe")));

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main();
