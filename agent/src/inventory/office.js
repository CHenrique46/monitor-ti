const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile: defaultExecFile } = require("child_process");

const CLICK_TO_RUN_PATHS = [
  "HKLM\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration"
];
const OSPP_TIMEOUT_MS = 30000;
const OSPP_MAX_BUFFER = 256 * 1024;
const OSPP_CANDIDATE_RELATIVE_PATHS = [
  "Microsoft Office\\root\\Office16\\ospp.vbs",
  "Microsoft Office\\Office16\\ospp.vbs",
  "Microsoft Office\\Office15\\ospp.vbs",
  "Microsoft Shared\\OfficeSoftwareProtectionPlatform\\ospp.vbs"
];

function text(value) {
  return value == null ? "" : String(value).trim();
}

function containsFullProductKey(value) {
  return /\b[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}\b/.test(text(value));
}

function firstValue(values, names) {
  for (const name of names) {
    if (values && values[name] != null && text(values[name]) && !containsFullProductKey(values[name])) return text(values[name]);
  }
  return null;
}

function splitProductIds(value) {
  return text(value).split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function classifyProduct(productReleaseId) {
  const id = text(productReleaseId).toUpperCase();
  if (!id) return "UNKNOWN";
  if (/M365|O365|OFFICE365|PROPLUSRETAIL/.test(id)) return "MICROSOFT_365";
  if (/LTSC/.test(id)) return "OFFICE_LTSC";
  if (/2021/.test(id)) return "OFFICE_2021";
  if (/2019/.test(id)) return "OFFICE_2019";
  return "OFFICE_OTHER";
}

function normalizeLicenseType(...values) {
  const combined = values.map(text).filter(Boolean).join(" ").toUpperCase();
  const types = [];
  if (/KMS/.test(combined)) types.push("VOLUME_KMS");
  if (/MAK/.test(combined)) types.push("VOLUME_MAK");
  if (/SUBSCRIPTION|SUBSCRIPTION_CHANNEL/.test(combined)) types.push("SUBSCRIPTION");
  if (/\bRETAIL\b/.test(combined)) types.push("RETAIL");
  return types.length === 1 ? types[0] : "UNKNOWN";
}

function normalizeActivationStatus(status) {
  const value = text(status).toUpperCase();
  if (!value) return "UNKNOWN";
  if (/UNLICENSED|UNLICENSE|NON.?LICENSED|ERROR/.test(value)) return "UNLICENSED";
  if (/NOTIFICATION|NOTIFICATIONS/.test(value)) return "NOTIFICATION";
  if (/GRACE/.test(value)) return "GRACE";
  if (/LICENSED/.test(value)) return "LICENSED";
  return "UNKNOWN";
}

function safePartialKey(value) {
  const candidate = text(value);
  return /^[A-Za-z0-9]{5}$/.test(candidate) ? candidate : null;
}

function parseClickToRun(records) {
  const input = Array.isArray(records) ? records : records ? [records] : [];
  const result = [];
  for (const record of input) {
    const values = record && (record.values || record.data || record);
    const productIds = splitProductIds(firstValue(values, ["ProductReleaseIds", "productReleaseIds"]));
    const ids = productIds.length ? productIds : [null];
    for (const productReleaseId of ids) {
      const version = firstValue(values, ["VersionToReport", "versionToReport", "ClientVersionToReport", "clientVersionToReport"]);
      const architecture = firstValue(values, ["Platform", "platform"]);
      const channel = firstValue(values, ["UpdateChannel", "updateChannel", "CDNBaseUrl", "cdnBaseUrl"]);
      result.push({
        source: "CLICK_TO_RUN",
        productReleaseId,
        productName: productReleaseId,
        edition: classifyProduct(productReleaseId),
        version,
        architecture,
        updateChannel: channel,
        installationTechnology: "Click-to-Run",
        activationStatus: "UNKNOWN",
        rawStatusCode: null,
        licenseType: normalizeLicenseType(productReleaseId),
        licenseName: null,
        licenseDescription: null,
        partialProductKey: null
      });
    }
  }
  return result.filter((item) => item.productReleaseId || item.version || item.architecture || item.updateChannel);
}

function parseMsiInstallations(records) {
  const input = Array.isArray(records) ? records : records ? [records] : [];
  return input.map((record) => {
    const values = record && (record.values || record.data || record);
    const productName = firstValue(values, ["DisplayName", "displayName"]);
    return {
      source: "MSI",
      productReleaseId: null,
      productName,
      edition: classifyProduct(productName),
      version: firstValue(values, ["DisplayVersion", "displayVersion"]),
      architecture: firstValue(values, ["Platform", "platform", "Architecture", "architecture"]),
      updateChannel: null,
      installationTechnology: "MSI",
      activationStatus: "UNKNOWN",
      rawStatusCode: null,
      licenseType: normalizeLicenseType(productName),
      licenseName: null,
      licenseDescription: null,
      partialProductKey: null
    };
  }).filter((item) => item.productName || item.version);
}

function parseStoreInstallations(records) {
  const input = Array.isArray(records) ? records : records ? [records] : [];
  return input.map((record) => {
    const values = record && (record.values || record.data || record);
    const productName = firstValue(values, ["DisplayName", "displayName", "Name", "name"]);
    return {
      source: "STORE",
      productReleaseId: null,
      productName,
      edition: classifyProduct(productName),
      version: firstValue(values, ["Version", "version"]),
      architecture: firstValue(values, ["Architecture", "architecture"]),
      updateChannel: null,
      installationTechnology: "Microsoft Store",
      activationStatus: "UNKNOWN",
      rawStatusCode: null,
      licenseType: "UNKNOWN",
      licenseName: null,
      licenseDescription: null,
      partialProductKey: null
    };
  }).filter((item) => item.productName || item.version);
}

function parseLabeledValue(line, labels) {
  const source = text(line);
  for (const label of labels) {
    const match = new RegExp("^\\s*" + label + "\\s*:\\s*(.*?)\\s*$", "i").exec(source);
    if (match && !containsFullProductKey(match[1])) return match[1].trim();
  }
  return null;
}

function parseOspp(output) {
  const raw = text(output);
  if (!raw) return [];
  const blocks = raw.split(/(?=^\s*LICENSE\s+NAME\s*:)/im).filter((block) => /LICENSE\s+NAME|LICENSE\s+STATUS|LAST\s+5/i.test(block));
  const parsed = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const licenseName = lines.map((line) => parseLabeledValue(line, ["LICENSE NAME"])).find(Boolean) || null;
    const licenseDescription = lines.map((line) => parseLabeledValue(line, ["LICENSE DESCRIPTION"])).find(Boolean) || null;
    const rawStatusCode = lines.map((line) => parseLabeledValue(line, ["LICENSE STATUS"])).find(Boolean) || null;
    const partialProductKey = lines
      .map((line) => parseLabeledValue(line, ["Last 5 characters of installed product key", "ULTIMOS 5 CARACTERES DA CHAVE DO PRODUTO INSTALADA"]))
      .map(safePartialKey)
      .find(Boolean) || null;
    if (!licenseName && !licenseDescription && !rawStatusCode && !partialProductKey) continue;
    parsed.push({
      source: "OSPP",
      productReleaseId: null,
      productName: licenseName,
      edition: classifyProduct(licenseName),
      version: null,
      architecture: null,
      updateChannel: null,
      installationTechnology: "MSI_OR_CLICK_TO_RUN",
      activationStatus: normalizeActivationStatus(rawStatusCode),
      rawStatusCode,
      licenseType: normalizeLicenseType(licenseName, licenseDescription),
      licenseName,
      licenseDescription,
      partialProductKey
    });
  }
  return parsed;
}

function fingerprintInstallation(installation) {
  const stable = {
    source: installation.source || null,
    productReleaseId: installation.productReleaseId || null,
    productName: installation.productName || null,
    edition: installation.edition || null,
    version: installation.version || null,
    architecture: installation.architecture || null,
    updateChannel: installation.updateChannel || null,
    installationTechnology: installation.installationTechnology || null,
    licenseType: installation.licenseType || null,
    licenseName: installation.licenseName || null,
    licenseDescription: installation.licenseDescription || null
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function finalizeInstallation(installation) {
  const result = {
    source: installation.source || "UNKNOWN",
    productReleaseId: installation.productReleaseId || null,
    productName: installation.productName || null,
    edition: installation.edition || "UNKNOWN",
    version: installation.version || null,
    architecture: installation.architecture || null,
    updateChannel: installation.updateChannel || null,
    installationTechnology: installation.installationTechnology || "UNKNOWN",
    activationStatus: installation.activationStatus || "UNKNOWN",
    rawStatusCode: installation.rawStatusCode || null,
    licenseType: installation.licenseType || "UNKNOWN",
    licenseName: installation.licenseName || null,
    licenseDescription: installation.licenseDescription || null,
    partialProductKey: safePartialKey(installation.partialProductKey),
    fingerprint: null
  };
  result.fingerprint = fingerprintInstallation(result);
  return result;
}

function uniquePaths(paths) {
  return Array.from(new Set(paths.filter(Boolean).map((item) => path.normalize(item))));
}

function discoverOsppScripts({ exists = fs.existsSync, env = process.env } = {}) {
  const roots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.CommonProgramFiles,
    env["CommonProgramFiles(x86)"]
  ].filter(Boolean);
  return uniquePaths(roots.flatMap((root) => OSPP_CANDIDATE_RELATIVE_PATHS.map((relative) => path.join(root, relative))))
    .filter((candidate) => exists(candidate));
}

function execFilePromise(execFile, file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = undefined;
        error.stderr = undefined;
        reject(error);
        return;
      }
      resolve({ stdout: text(stdout), stderr: text(stderr) });
    });
  });
}

function readOfficeRegistry(execFile = defaultExecFile) {
  const script = "$paths=@('HKLM:\\SOFTWARE\\Microsoft\\Office\\ClickToRun\\Configuration','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Office\\ClickToRun\\Configuration');$click=$paths|ForEach-Object{try{Get-ItemProperty -Path $_ -ErrorAction Stop|Select-Object ProductReleaseIds,VersionToReport,ClientVersionToReport,Platform,UpdateChannel,CDNBaseUrl}catch{}};$uninstall=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');$msi=$uninstall|ForEach-Object{Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName -match 'Microsoft (365|Office)' }|Select-Object DisplayName,DisplayVersion,Platform,Architecture};[pscustomobject]@{clickToRun=@($click);msi=@($msi)}|ConvertTo-Json -Compress";
  return execFilePromise(execFile, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: OSPP_TIMEOUT_MS, maxBuffer: OSPP_MAX_BUFFER })
    .then(({ stdout }) => stdout ? JSON.parse(stdout) : { clickToRun: [], msi: [] });
}

async function collectOfficeInventory(options = {}) {
  const warnings = [];
  const readRegistry = options.readRegistry || (() => readOfficeRegistry(options.execFile || defaultExecFile));
  const execFile = options.execFile || defaultExecFile;
  let registry = {};
  try {
    registry = await readRegistry();
  } catch (error) {
    warnings.push("registry_read_failed");
  }

  const installations = [
    ...parseClickToRun(registry.clickToRun || registry.clickToRunRecords || registry),
    ...parseMsiInstallations(registry.msi || registry.msiRecords),
    ...parseStoreInstallations(registry.store || registry.storeRecords)
  ];
  const osppScripts = options.osppScripts || discoverOsppScripts(options);
  for (const script of osppScripts) {
    try {
      const result = await execFilePromise(execFile, "cscript.exe", ["//Nologo", script, "/dstatus"], {
        windowsHide: true,
        timeout: options.timeoutMs || OSPP_TIMEOUT_MS,
        maxBuffer: options.maxBuffer || OSPP_MAX_BUFFER
      });
      installations.push(...parseOspp(result.stdout));
    } catch (error) {
      warnings.push(error && error.killed ? "ospp_timeout" : "ospp_execution_failed");
    }
  }

  const finalized = installations.map(finalizeInstallation);
  return {
    collectedAt: new Date().toISOString(),
    installations: finalized,
    warnings: Array.from(new Set(warnings))
  };
}

module.exports = {
  CLICK_TO_RUN_PATHS,
  OSPP_CANDIDATE_RELATIVE_PATHS,
  OSPP_TIMEOUT_MS,
  OSPP_MAX_BUFFER,
  classifyProduct,
  normalizeLicenseType,
  normalizeActivationStatus,
  containsFullProductKey,
  safePartialKey,
  parseClickToRun,
  parseMsiInstallations,
  parseStoreInstallations,
  parseOspp,
  fingerprintInstallation,
  discoverOsppScripts,
  collectOfficeInventory
};
