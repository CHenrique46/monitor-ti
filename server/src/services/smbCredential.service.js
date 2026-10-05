const path = require("path");
const { spawn } = require("child_process");
const {
  getCertificadosClientesPath,
  getCertificadosSmbSecretPath,
  getCertificadosSmbExpectedIdentity
} = require("../config");

const HELPER_PATH = path.join(__dirname, "smbCredentialConnection.ps1");

function shareRoot(value) {
  const match = String(value || "").trim().match(/^\\\\([^\\]+)\\([^\\]+)/);
  return match ? `\\\\${match[1]}\\${match[2]}` : null;
}

function connectionRoots() {
  return {
    source: shareRoot(getCertificadosClientesPath()),
    destination: shareRoot(process.env.CERTIFICADOS_LIBERADOS_PATH)
  };
}

function createDefaultRunner({ spawnProcess = spawn } = {}) {
  return (operation) => new Promise((resolve) => {
    let roots;
    let secretPath;
    let expectedIdentity;
    try {
      roots = connectionRoots();
      secretPath = getCertificadosSmbSecretPath();
      expectedIdentity = getCertificadosSmbExpectedIdentity();
    } catch (error) {
      resolve({ ok: false, code: error.code || "SMB_CONFIGURATION_INVALID" });
      return;
    }
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER_PATH, "-Operation", operation, "-SecretPath", secretPath, "-ExpectedIdentity", expectedIdentity];
    if (roots.source) args.push("-SourceShareRoot", roots.source);
    if (roots.destination) args.push("-DestinationShareRoot", roots.destination);
    const child = spawnProcess("powershell.exe", args, { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", () => resolve({ ok: false, code: "SMB_HELPER_FAILED" }));
    child.on("close", () => {
      const result = stdout.split(/\r?\n/).reduce((value, line) => {
        const [key, ...parts] = line.trim().split("=");
        if (key === "SMB_RESULT") {
          value.ok = parts.join("=") === "OK";
          if (value.ok) value.code = null;
        }
        if (key === "SMB_CODE") {
          const code = parts.join("=").slice(0, 64);
          value.code = /^SMB_[A-Z0-9_]+$/.test(code) ? code : "SMB_HELPER_FAILED";
        }
        return value;
      }, { ok: false, code: "SMB_HELPER_FAILED" });
      resolve(result);
    });
  });
}

function createSmbCredentialConnection({ runner = createDefaultRunner(), log = () => {} } = {}) {
  let ownedConnection = false;

  async function connect() {
    if (ownedConnection) return { ok: true, code: null };
    const result = await runner("connect");
    if (result.ok) ownedConnection = true;
    else log(result.code || "SMB_HELPER_FAILED");
    return result;
  }

  async function disconnect() {
    if (!ownedConnection) return { ok: true, code: null, skipped: true };
    const result = await runner("disconnect");
    ownedConnection = false;
    if (!result.ok && result.code !== "SMB_CONNECTION_NOT_FOUND") log(result.code || "SMB_HELPER_FAILED");
    return result;
  }

  return { connect, disconnect, ownsConnection: () => ownedConnection };
}

async function startSchedulerWhenReady({ connection, scheduler, log = () => {} }) {
  const result = await connection.connect();
  if (!result.ok) {
    log(result.code || "SMB_HELPER_FAILED");
    return false;
  }
  scheduler.start();
  return true;
}

module.exports = { HELPER_PATH, shareRoot, connectionRoots, createDefaultRunner, createSmbCredentialConnection, startSchedulerWhenReady };
