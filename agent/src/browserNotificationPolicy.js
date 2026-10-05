const { execFileSync: defaultExecFileSync } = require("child_process");

const POLICY_ROOT = "SOFTWARE\\Policies\\Google\\Chrome";
const STATE_ROOT = "SOFTWARE\\MonitorTI\\Agent";
const MODERN_POLICY = "OverrideSecurityRestrictionsOnInsecureOrigin";
const LEGACY_POLICY = "UnsafelyTreatInsecureOriginAsSecure";
const ALLOWED_POLICY = "NotificationsAllowedForUrls";
const ORIGIN = "http://192.168.40.133:4000";
const OWNERSHIP_VERSION = "1.1.26";
const CAPABILITY = "browser_notification_policy_v1";

function sanitizeLogValue(value) {
  return String(value || "").replace(/[\r\n]/g, " ").replace(/[^a-zA-Z0-9_.:/=-]/g, "_").slice(0, 160);
}

function invokePowerShell(script, execFileSync = defaultExecFileSync) {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000, maxBuffer: 1024 * 1024 }
  );
  return JSON.parse(String(output || "{}").trim() || "{}");
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function createRegistry64Adapter({ execFileSync = defaultExecFileSync, platform = process.platform } = {}) {
  function readPolicy(name) {
    if (platform !== "win32") return { ok: false, error: "NON_WINDOWS" };
    try {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)",
        "$key=$base.OpenSubKey(" + psQuote(POLICY_ROOT + "\\" + name) + ")",
        "$values=[ordered]@{}",
        "if($key){foreach($n in $key.GetValueNames()){if($n -match '^\\d+$'){$values[$n]=[string]$key.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}}",
        "[pscustomobject]@{ok=$true;exists=($null -ne $key);values=$values}|ConvertTo-Json -Compress"
      ].join("; ");
      return invokePowerShell(script, execFileSync);
    } catch (error) {
      return { ok: false, error: "READ_FAILED" };
    }
  }

  function writePolicyValue(name, index, value) {
    if (platform !== "win32") return { ok: false, error: "NON_WINDOWS" };
    try {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)",
        "$key=$base.CreateSubKey(" + psQuote(POLICY_ROOT + "\\" + name) + ")",
        "$key.SetValue(" + psQuote(index) + "," + psQuote(value) + ",[Microsoft.Win32.RegistryValueKind]::String)",
        "[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress"
      ].join("; ");
      return invokePowerShell(script, execFileSync);
    } catch (error) {
      return { ok: false, error: "WRITE_DENIED" };
    }
  }

  function deletePolicyValue(name, index) {
    if (platform !== "win32") return { ok: false, error: "NON_WINDOWS" };
    try {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)",
        "$key=$base.OpenSubKey(" + psQuote(POLICY_ROOT + "\\" + name) + ",$true)",
        "if($key -and $key.GetValueNames() -contains " + psQuote(index) + "){$key.DeleteValue(" + psQuote(index) + ",$false)}",
        "[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress"
      ].join("; ");
      return invokePowerShell(script, execFileSync);
    } catch (error) {
      return { ok: false, error: "DELETE_DENIED" };
    }
  }

  function readOwnership() {
    if (platform !== "win32") return { ok: false, error: "NON_WINDOWS" };
    try {
      const script = [
        "$ErrorActionPreference='Stop'",
        "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)",
        "$key=$base.OpenSubKey(" + psQuote(STATE_ROOT) + ")",
        "$raw=if($key){$key.GetValue('BrowserNotificationPolicyOwnership',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}else{$null}",
        "[pscustomobject]@{ok=$true;raw=$raw}|ConvertTo-Json -Compress"
      ].join("; ");
      const result = invokePowerShell(script, execFileSync);
      return { ok: result.ok === true, state: result.raw ? JSON.parse(result.raw) : null };
    } catch (error) {
      return { ok: false, error: "STATE_READ_FAILED" };
    }
  }

  function writeOwnership(state) {
    if (platform !== "win32") return { ok: false, error: "NON_WINDOWS" };
    try {
      const raw = JSON.stringify(state);
      const script = [
        "$ErrorActionPreference='Stop'",
        "$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)",
        "$key=$base.CreateSubKey(" + psQuote(STATE_ROOT) + ")",
        "$key.SetValue('BrowserNotificationPolicyOwnership'," + psQuote(raw) + ",[Microsoft.Win32.RegistryValueKind]::String)",
        "[pscustomobject]@{ok=$true}|ConvertTo-Json -Compress"
      ].join("; ");
      return invokePowerShell(script, execFileSync);
    } catch (error) {
      return { ok: false, error: "STATE_WRITE_FAILED" };
    }
  }

  function deleteOwnership() {
    return writeOwnership(null);
  }

  return { readPolicy, writePolicyValue, deletePolicyValue, readOwnership, writeOwnership, deleteOwnership };
}

function normalizeValues(policy) {
  const values = policy && policy.values && typeof policy.values === "object" ? policy.values : {};
  return Object.entries(values).map(([index, value]) => ({ index: String(index), value: String(value) }));
}

function findValue(policy, value) {
  return normalizeValues(policy).find((entry) => entry.value === value) || null;
}

function nextIndex(policy) {
  const used = new Set(normalizeValues(policy).map((entry) => entry.index));
  let index = 1;
  while (used.has(String(index))) index += 1;
  return String(index);
}

function hasOwnedLegacy(state, legacyPolicy, origin) {
  if (!state || state.createdByVersion !== OWNERSHIP_VERSION || !Array.isArray(state.entries)) return null;
  return state.entries.find((entry) => entry.policy === legacyPolicy && entry.value === origin) || null;
}

function ensureBrowserNotificationPolicies({ registry, origin = ORIGIN, log = () => {} } = {}) {
  if (!registry) return { valid: false, reason: "REGISTRY_UNAVAILABLE", capability: null };
  const created = [];
  const previousStateResult = registry.readOwnership();
  if (!previousStateResult.ok) return { valid: false, reason: "OWNERSHIP_UNAVAILABLE", capability: null };
  const previousState = previousStateResult.state || null;

  try {
    let modern = registry.readPolicy(MODERN_POLICY);
    let allowed = registry.readPolicy(ALLOWED_POLICY);
    const legacy = registry.readPolicy(LEGACY_POLICY);
    if (!modern.ok || !allowed.ok || !legacy.ok) throw new Error("POLICY_READ_FAILED");

    if (!findValue(modern, origin)) {
      const index = nextIndex(modern);
      const result = registry.writePolicyValue(MODERN_POLICY, index, origin);
      if (!result.ok) throw new Error("MODERN_POLICY_WRITE_FAILED");
      created.push({ policy: MODERN_POLICY, index, value: origin });
    }
    if (!findValue(allowed, origin)) {
      const index = nextIndex(allowed);
      const result = registry.writePolicyValue(ALLOWED_POLICY, index, origin);
      if (!result.ok) throw new Error("ALLOWED_POLICY_WRITE_FAILED");
      created.push({ policy: ALLOWED_POLICY, index, value: origin });
    }

    modern = registry.readPolicy(MODERN_POLICY);
    allowed = registry.readPolicy(ALLOWED_POLICY);
    if (!modern.ok || !allowed.ok || !findValue(modern, origin) || !findValue(allowed, origin)) {
      throw new Error("POLICY_VALIDATION_FAILED");
    }

    const state = { schema: 1, createdByVersion: "1.1.27", entries: created };
    if (registry.writeOwnership(state).ok !== true) throw new Error("OWNERSHIP_COMMIT_FAILED");

    const ownedLegacy = hasOwnedLegacy(previousState, LEGACY_POLICY, origin);
    if (ownedLegacy) {
      const currentLegacy = registry.readPolicy(LEGACY_POLICY);
      const current = currentLegacy.ok && normalizeValues(currentLegacy).find((entry) => entry.index === ownedLegacy.index && entry.value === origin);
      if (current) registry.deletePolicyValue(LEGACY_POLICY, ownedLegacy.index);
      log("browser_policy_legacy_migrated index=" + sanitizeLogValue(ownedLegacy.index));
    }
    return { valid: true, capability: CAPABILITY, created, legacyMigrated: !!ownedLegacy };
  } catch (error) {
    for (const entry of created.reverse()) {
      const current = registry.readPolicy(entry.policy);
      const found = current.ok && normalizeValues(current).find((value) => value.index === entry.index && value.value === entry.value);
      if (found) registry.deletePolicyValue(entry.policy, entry.index);
    }
    registry.writeOwnership(previousState);
    log("browser_policy_validation_failed reason=" + sanitizeLogValue(error.message));
    return { valid: false, reason: sanitizeLogValue(error.message), capability: null };
  }
}

module.exports = {
  POLICY_ROOT,
  MODERN_POLICY,
  LEGACY_POLICY,
  ALLOWED_POLICY,
  ORIGIN,
  CAPABILITY,
  OWNERSHIP_VERSION,
  createRegistry64Adapter,
  ensureBrowserNotificationPolicies,
  normalizeValues
};
