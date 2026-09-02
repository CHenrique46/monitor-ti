const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CLICK_TO_RUN_PATHS,
  classifyProduct,
  normalizeActivationStatus,
  normalizeLicenseType,
  safePartialKey,
  parseClickToRun,
  parseMsiInstallations,
  parseStoreInstallations,
  parseOspp,
  fingerprintInstallation,
  discoverOsppScripts,
  collectOfficeInventory
} = require("./src/inventory/office");

const clickToRun365 = {
  ProductReleaseIds: "O365ProPlusRetail",
  VersionToReport: "16.0.17628.20144",
  ClientVersionToReport: "16.0.17628.20144",
  Platform: "x64",
  UpdateChannel: "Current",
  CDNBaseUrl: "https://officecdn.microsoft.com/pr/"
};

const ltscOspp = [
  "LICENSE NAME: Office 21, Office21ProPlus2021VL_KMS_Client edition",
  "LICENSE DESCRIPTION: Office 21, VOLUME_KMSCLIENT channel",
  "LICENSE STATUS: ---LICENSED---",
  "Last 5 characters of installed product key: KMS21"
].join("\r\n");

test("Click-to-Run parses Microsoft 365 fields", () => {
  const [item] = parseClickToRun([{ path: CLICK_TO_RUN_PATHS[0], values: clickToRun365 }]);
  assert.equal(item.source, "CLICK_TO_RUN");
  assert.equal(item.productReleaseId, "O365ProPlusRetail");
  assert.equal(item.edition, "MICROSOFT_365");
  assert.equal(item.version, "16.0.17628.20144");
  assert.equal(item.architecture, "x64");
  assert.equal(item.updateChannel, "Current");
  assert.equal(item.installationTechnology, "Click-to-Run");
});

test("Click-to-Run classifies Office LTSC/2021 and tolerates incomplete records", () => {
  const [item] = parseClickToRun([{ values: { ProductReleaseIds: "ProPlus2021Volume", Platform: "x86" } }]);
  assert.equal(item.edition, "OFFICE_2021");
  assert.equal(item.version, null);
  assert.deepEqual(parseClickToRun([{ values: {} }]), []);
});

test("MSI discovery is limited to supplied uninstall records", () => {
  const [item] = parseMsiInstallations([{ DisplayName: "Microsoft Office Professional Plus 2019", DisplayVersion: "16.0.10396.20023", Architecture: "x86" }]);
  assert.equal(item.source, "MSI");
  assert.equal(item.installationTechnology, "MSI");
  assert.equal(item.edition, "OFFICE_2019");
  assert.equal(item.architecture, "x86");
});

test("Store parser remains best-effort and never invents license data", () => {
  const [item] = parseStoreInstallations([{ Name: "Microsoft 365", Version: "16.0.1", Architecture: "x64" }]);
  assert.equal(item.source, "STORE");
  assert.equal(item.installationTechnology, "Microsoft Store");
  assert.equal(item.licenseType, "UNKNOWN");
  assert.equal(item.activationStatus, "UNKNOWN");
});

test("OSPP parses licensed KMS data and only the last five characters", () => {
  const [item] = parseOspp(ltscOspp);
  assert.equal(item.activationStatus, "LICENSED");
  assert.equal(item.licenseType, "VOLUME_KMS");
  assert.equal(item.partialProductKey, "KMS21");
  assert.equal(item.rawStatusCode, "---LICENSED---");
});

test("OSPP normalizes notification and grace statuses", () => {
  assert.equal(normalizeActivationStatus("---NOTIFICATIONS---"), "NOTIFICATION");
  assert.equal(normalizeActivationStatus("---OOB_GRACE---"), "GRACE");
  assert.equal(normalizeActivationStatus("unrecognized status"), "UNKNOWN");
  assert.equal(normalizeActivationStatus("---UNLICENSED---"), "UNLICENSED");
});

test("OSPP classifies explicit MAK and Retail evidence", () => {
  assert.equal(normalizeLicenseType("Office Retail edition"), "RETAIL");
  assert.equal(normalizeLicenseType("VOLUME_MAK channel"), "VOLUME_MAK");
  assert.equal(normalizeLicenseType("Retail MAK"), "UNKNOWN");
  assert.equal(classifyProduct("OfficeLTSC2021Volume"), "OFFICE_LTSC");
});

test("OSPP parses multiple licenses without returning raw output", () => {
  const output = [
    "LICENSE NAME: Office 16, Office16O365ProPlusR_Subscription1 edition\nLICENSE STATUS: ---LICENSED---\nLast 5 characters of installed product key: ABCDE",
    "LICENSE NAME: Office 21, Office21Standard2021VL_MAK edition\nLICENSE DESCRIPTION: VOLUME_MAK channel\nLICENSE STATUS: ---NOTIFICATIONS---\nLast 5 characters of installed product key: 12345"
  ].join("\n");
  const result = parseOspp(output);
  assert.equal(result.length, 2);
  assert.equal(result[0].partialProductKey, "ABCDE");
  assert.equal(result[1].licenseType, "VOLUME_MAK");
  assert.equal(JSON.stringify(result).includes(output), false);
});

test("OSPP rejects malformed output and complete-looking keys", () => {
  const result = parseOspp("unexpected output\nProduct Key: ABCDE-12345-FGHIJ-KLMNO-PQRST\nLast 5 characters of installed product key: ABCDE-12345");
  assert.deepEqual(result, []);
  assert.equal(safePartialKey("ABCDE"), "ABCDE");
  assert.equal(safePartialKey("ABCDE-12345-FGHIJ-KLMNO-PQRST"), null);
});

test("missing OSPP paths are harmless and dynamically discovered", () => {
  const found = discoverOsppScripts({ env: { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86" }, exists: (file) => file.endsWith("Office16\\ospp.vbs") });
  assert.equal(found.length, 4);
  assert.deepEqual(discoverOsppScripts({ env: {}, exists: () => false }), []);
});

test("fingerprint excludes host, user and key material", () => {
  const base = { source: "OSPP", productName: "Office", version: "1", partialProductKey: "ABCDE" };
  const first = fingerprintInstallation(base);
  const second = fingerprintInstallation({ ...base, partialProductKey: "ZZZZZ" });
  assert.equal(first, second);
  assert.equal(first.length, 64);
});

test("collector returns inventory without raw OSPP output", async () => {
  const result = await collectOfficeInventory({
    readRegistry: async () => ({ clickToRun: [{ values: clickToRun365 }], msi: [] }),
    osppScripts: ["C:\\Office16\\ospp.vbs"],
    execFile: (_file, _args, _options, callback) => callback(null, ltscOspp, "")
  });
  assert.equal(result.installations.length, 2);
  assert.deepEqual(result.warnings, []);
  assert.equal(JSON.stringify(result).includes("License NAME"), false);
});

test("collector reports OSPP timeout without exposing command output", async () => {
  const result = await collectOfficeInventory({
    readRegistry: async () => ({ clickToRun: [], msi: [] }),
    osppScripts: ["C:\\Office16\\ospp.vbs"],
    execFile: (_file, _args, _options, callback) => {
      const error = new Error("timeout");
      error.killed = true;
      callback(error, "SECRET RAW OUTPUT", "SECRET ERROR OUTPUT");
    }
  });
  assert.deepEqual(result.installations, []);
  assert.deepEqual(result.warnings, ["ospp_timeout"]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
