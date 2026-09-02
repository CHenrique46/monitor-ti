const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyRecord, normalizeOfficeInstallations } = require("./src/inventory/officeNormalization");

const vava67 = [
  { source: "MSI", productName: "Microsoft Office Home and Business 2013 - pt-br", version: "15.0.5603.1000", installationTechnology: "MSI", collectedAt: "2026-09-02T16:41:47.976Z" },
  { source: "MSI", productName: "Microsoft Teams Meeting Add-in for Microsoft Office", version: "1.24.31301", installationTechnology: "MSI" },
  { source: "OSPP", productName: "Office 15, OfficeHomeBusinessR_Grace edition", activationStatus: "NOTIFICATION", licenseType: "RETAIL", partialProductKey: "DV3TM", licenseDescription: "Office 15, RETAIL(Grace) channel" },
  { source: "OSPP", productName: "Office 15, OfficeHomeBusinessR_Retail edition", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "PYQTQ", licenseDescription: "Office 15, RETAIL channel" }
];

test("normalizes the VAVA67 canary without changing raw rows", () => {
  const result = normalizeOfficeInstallations(vava67);
  assert.equal(result.products.length, 1);
  assert.equal(result.components.length, 1);
  assert.equal(result.summary.licenseRecordCount, 2);
  assert.equal(result.products[0].productName, vava67[0].productName);
  assert.equal(result.products[0].editionFamily, "HOME_BUSINESS");
  assert.equal(result.products[0].releaseYear, 2013);
  assert.equal(result.products[0].primaryLicense.partialProductKey, "PYQTQ");
  assert.equal(result.products[0].additionalLicenseStates[0].activationStatus, "NOTIFICATION");
  assert.equal(result.components[0].version, "1.24.31301");
  assert.equal(JSON.stringify(result).includes("fingerprint"), false);
});

test("classifies strong source and component signals", () => {
  assert.equal(classifyRecord({ source: "OSPP", productName: "Office" }), "LICENSE_RECORD");
  assert.equal(classifyRecord({ source: "MSI", productName: "Teams Meeting Add-in" }), "COMPONENT");
  assert.equal(classifyRecord({ source: "MSI", productName: "Microsoft Office 2019" }), "PRODUCT");
  assert.equal(classifyRecord({ source: "OTHER" }), "UNKNOWN");
});

test("does not correlate incompatible licenses", () => {
  const result = normalizeOfficeInstallations([
    { source: "MSI", productName: "Microsoft Office Home and Business 2013", version: "15.0" },
    { source: "OSPP", productName: "Office 15, OfficeProfessionalR_Retail edition", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "ABCDE" }
  ]);
  assert.equal(result.products[0].primaryLicense, null);
  assert.equal(result.uncorrelatedLicenseRecords.length, 1);
});

test("supports absent office and unlicensed products", () => {
  assert.equal(normalizeOfficeInstallations([]).summary.productCount, 0);
  const result = normalizeOfficeInstallations([{ source: "CLICK_TO_RUN", productReleaseId: "O365ProPlusRetail", version: "16.0" }]);
  assert.equal(result.products[0].productFamily, "MICROSOFT_365");
  assert.equal(result.products[0].primaryLicense, null);
});

test("keeps a license without a product uncorrelated", () => {
  const result = normalizeOfficeInstallations([{ source: "OSPP", productName: "OfficeProfessionalR_Retail edition", activationStatus: "LICENSED", licenseType: "RETAIL", partialProductKey: "ABCDE" }]);
  assert.equal(result.products.length, 0);
  assert.equal(result.uncorrelatedLicenseRecords.length, 1);
});
