const path = require("path");
const { spawn } = require("child_process");

const HELPER_TIMEOUT_MS = 120 * 1000;
const HELPER_KILL_WAIT_MS = 2 * 1000;
const MAX_INPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024;
const HELPER_PATH = path.join(__dirname, "certificateRemovalHelper.ps1");
const POWERSHELL_PATH = process.env.CERTIFICATE_POWERSHELL_PATH || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const ALLOWED_OPERATIONS = new Set(["inspect", "inspect_presence", "remove", "remove_temp"]);
const RESULT_CODES = new Set(["ABSENT", "PRESENT", "PRESENT_VALID", "REMOVED", "ERROR"]);

function sanitizeCode(value) {
  const code = String(value || "HELPER_FAILED").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return code || "HELPER_FAILED";
}

function validateRequest(request) {
  if (!request || !ALLOWED_OPERATIONS.has(request.operation)) throw Object.assign(new Error("Helper input inválido."), { code: "HELPER_INPUT_INVALID" });
  const root = String(request.destinationRoot || "");
  const filename = String(request.filename || "");
  const fingerprint = String(request.expectedFingerprint || "");
  if (root.length === 0 || root.length > 4096 || filename.length === 0 || filename.length > 255 || ((request.operation !== "remove_temp" && request.operation !== "inspect_presence") && !/^[A-Fa-f0-9]{64}$/.test(fingerprint))) throw Object.assign(new Error("Helper input inválido."), { code: "HELPER_INPUT_INVALID" });
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(root) || /[?*\u0000-\u001f]/.test(root) || /(^|[\\/])\.\.([\\/]|$)/.test(root)) throw Object.assign(new Error("Helper input inválido."), { code: "HELPER_INPUT_INVALID" });
  if (path.basename(filename) !== filename || (request.operation === "remove_temp" ? !/^\.[0-9a-f-]{36}\.(?:pfx|p12)\.tmp$/i.test(filename) : !/^[^./]+\.(?:pfx|p12)$/i.test(filename)) || /[\\/:*?"<>|\u0000-\u001f]/.test(filename) || filename.includes("..")) throw Object.assign(new Error("Helper input inválido."), { code: "HELPER_INPUT_INVALID" });
  return { operation: request.operation, destinationRoot: root, filename, expectedFingerprint: fingerprint.toLowerCase() };
}

function validatePowerShellPath() {
  if (!path.isAbsolute(POWERSHELL_PATH) || path.basename(POWERSHELL_PATH).toLowerCase() !== "powershell.exe") throw Object.assign(new Error("PowerShell inválido."), { code: "HELPER_CONFIGURATION_INVALID" });
  return POWERSHELL_PATH;
}

function helperEnvironment() {
  return Object.fromEntries(["SystemRoot", "SystemDrive", "windir", "Path", "PATHEXT", "TEMP", "TMP"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
}

function createCertificateRemovalHelper({ spawnProcess = spawn, helperPath = HELPER_PATH, powershellPath = POWERSHELL_PATH, timeoutMs = HELPER_TIMEOUT_MS, killWaitMs = HELPER_KILL_WAIT_MS, log = () => {} } = {}) {
  const active = new Set();
  const waiters = new Map();
  let stopping = false;

  function stop() {
    stopping = true;
    const pending = [...active].map((child) => new Promise((resolve) => {
      const list = waiters.get(child) || [];
      list.push(resolve);
      waiters.set(child, list);
      try { child.kill(); } catch (_) {}
    }));
    return Promise.all(pending);
  }

  function run(rawRequest) {
    return new Promise((resolve) => {
      if (stopping) { resolve({ ok: false, result: "ERROR", code: "HELPER_SHUTTING_DOWN" }); return; }
      let request;
      try { request = validateRequest(rawRequest); validatePowerShellPath(); } catch (error) { resolve({ ok: false, result: "ERROR", code: sanitizeCode(error.code) }); return; }
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input, "utf8") > MAX_INPUT_BYTES) { resolve({ ok: false, result: "ERROR", code: "HELPER_INPUT_LIMIT" }); return; }
      let child;
      try { child = spawnProcess(powershellPath, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath], { windowsHide: true, shell: false, env: helperEnvironment() }); }
      catch { resolve({ ok: false, result: "ERROR", code: "HELPER_SPAWN_FAILED" }); return; }
      active.add(child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      const finish = (value) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); active.delete(child); for (const resolveWaiter of waiters.get(child) || []) resolveWaiter(); waiters.delete(child); resolve(value); };
      const limit = (chunk, current) => (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES + 1);
      child.stdout?.on("data", (chunk) => { stdout = limit(chunk, stdout); if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) { try { child.kill(); } catch (_) {} finish({ ok: false, result: "ERROR", code: "HELPER_OUTPUT_LIMIT" }); } });
      child.stderr?.on("data", (chunk) => { stderr = limit(chunk, stderr); });
      child.on("error", () => finish({ ok: false, result: "ERROR", code: "HELPER_SPAWN_FAILED" }));
      child.on("close", (exitCode) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(stdout);
          const keys = Object.keys(parsed).sort().join(",");
          if (keys !== "code,ok,result" || typeof parsed.ok !== "boolean" || typeof parsed.result !== "string" || !RESULT_CODES.has(parsed.result) || (typeof parsed.code !== "string" && parsed.code !== null)) throw new Error();
          finish({ ok: parsed.ok, result: parsed.result, code: parsed.ok ? null : sanitizeCode(parsed.code) });
        } catch { finish({ ok: false, result: "ERROR", code: exitCode === 0 ? "HELPER_OUTPUT_INVALID" : "HELPER_EXIT_FAILED" }); }
      });
      try { child.stdin?.end(input); } catch (_) { finish({ ok: false, result: "ERROR", code: "HELPER_STDIN_FAILED" }); }
      timer = setTimeout(() => {
        try { child.kill(); } catch (_) {}
        const escalation = setTimeout(() => { try { child.kill(); } catch (_) {} finish({ ok: false, result: "ERROR", code: "HELPER_TIMEOUT" }); }, killWaitMs);
        escalation.unref?.();
      }, timeoutMs);
    });
  }

  return { run, stop, activeCount: () => active.size, timeoutMs };
}

module.exports = { HELPER_TIMEOUT_MS, HELPER_KILL_WAIT_MS, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES, HELPER_PATH, POWERSHELL_PATH, createCertificateRemovalHelper, validateRequest, validatePowerShellPath, helperEnvironment };
