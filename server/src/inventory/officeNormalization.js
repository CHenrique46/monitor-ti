const text = (value) => String(value || "").trim();

function upper(item) {
  return text(item).toUpperCase();
}

function tokens(item) {
  return upper(item).replace(/[^A-Z0-9]+/g, " ");
}

function isComponent(item) {
  return /\b(ADD[ -]?IN|PLUGIN|EXTENSION|MEETING)\b/.test(tokens(item));
}

function editionFamily(item) {
  const value = tokens(item);
  if (/HOME BUSINESS|HOME AND BUSINESS|HOMEBUSINESS/.test(value)) return "HOME_BUSINESS";
  if (/PROFESSIONAL/.test(value)) return "PROFESSIONAL";
  if (/STANDARD/.test(value)) return "STANDARD";
  if (/PRO PLUS|PROPLUS/.test(value)) return "PRO_PLUS";
  return "UNKNOWN";
}

function releaseYear(item) {
  const value = upper(item);
  const explicit = value.match(/\b(2013|2016|2019|2021|2024)\b/);
  if (explicit) return Number(explicit[1]);
  if (/\bOFFICE\s*15\b|OFFICE15/.test(value)) return 2013;
  return null;
}

function identity(item) {
  const value = [item.productReleaseId, item.productName, item.licenseName, item.licenseDescription].map(text).join(" ");
  const family = /M365|O365|OFFICE365|SUBSCRIPTION/.test(upper(value)) ? "MICROSOFT_365" :
    /OFFICE|PROPLUS|HOMEBUSINESS|PROFESSIONAL|STANDARD/.test(upper(value)) ? "OFFICE_PERPETUAL" : "UNKNOWN";
  const servicingModel = /LTSC/.test(upper(value)) ? "LTSC" :
    family === "MICROSOFT_365" ? "SUBSCRIPTION" : family === "OFFICE_PERPETUAL" ? "PERPETUAL" : "UNKNOWN";
  const evidence = [];
  if (item.source) evidence.push(`source:${item.source}`);
  if (item.productReleaseId) evidence.push("productReleaseId");
  if (item.productName) evidence.push("productName");
  if (item.licenseName || item.licenseDescription) evidence.push("licenseMetadata");
  return { productFamily: family, editionFamily: editionFamily(value), releaseYear: releaseYear(value), servicingModel, confidence: evidence.length ? "high" : "low", evidence };
}

function classifyRecord(item) {
  if (!item || typeof item !== "object") return "UNKNOWN";
  if (upper(item.source) === "OSPP") return "LICENSE_RECORD";
  if (isComponent(item.productName)) return "COMPONENT";
  if (["MSI", "CLICK_TO_RUN", "STORE"].includes(upper(item.source)) && (item.productName || item.productReleaseId || item.version)) return "PRODUCT";
  return "UNKNOWN";
}

function licenseView(item) {
  return {
    productName: item.productName || item.licenseName || null,
    licenseName: item.licenseName || null,
    licenseDescription: item.licenseDescription || null,
    activationStatus: item.activationStatus || "UNKNOWN",
    licenseType: item.licenseType || "UNKNOWN",
    partialProductKey: /^[A-Za-z0-9]{5}$/.test(text(item.partialProductKey)) ? item.partialProductKey : null,
    source: item.source || null
  };
}

function matchScore(product, license) {
  const p = product;
  const l = license.identity;
  let score = 0;
  if (p.editionFamily !== "UNKNOWN" && p.editionFamily === l.editionFamily) score += 4;
  if (p.productFamily !== "UNKNOWN" && p.productFamily === l.productFamily) score += 2;
  if (p.releaseYear && p.releaseYear === l.releaseYear) score += 2;
  if (p.servicingModel === "LTSC" && l.servicingModel === "LTSC") score += 1;
  return score;
}

function normalizeOfficeInstallations(installations) {
  const records = Array.isArray(installations) ? installations : [];
  const classified = records.map((item) => ({ item, kind: classifyRecord(item), identity: identity(item) }));
  const products = classified.filter((record) => record.kind === "PRODUCT").map((record) => ({
    productName: record.item.productName || record.item.productReleaseId || null,
    version: record.item.version || null,
    architecture: record.item.architecture || null,
    updateChannel: record.item.updateChannel || null,
    installationTechnology: record.item.installationTechnology || null,
    collectedAt: record.item.collectedAt || null,
    ...record.identity,
    primaryLicense: null,
    additionalLicenseStates: []
  }));
  const licenses = classified.filter((record) => record.kind === "LICENSE_RECORD");
  const uncorrelatedLicenseRecords = [];

  for (const license of licenses) {
    const matches = products.map((product, index) => ({ index, score: matchScore(product, license) })).filter((match) => match.score >= 6).sort((a, b) => b.score - a.score);
    if (!matches.length || (matches.length > 1 && matches[0].score === matches[1].score)) {
      uncorrelatedLicenseRecords.push(licenseView(license.item));
      continue;
    }
    const product = products[matches[0].index];
    const view = licenseView(license.item);
    if (!product.primaryLicense) product.primaryLicense = view;
    else if (view.activationStatus === "LICENSED" && product.primaryLicense.activationStatus !== "LICENSED") {
      product.additionalLicenseStates.push(product.primaryLicense);
      product.primaryLicense = view;
    } else product.additionalLicenseStates.push(view);
  }

  const components = classified.filter((record) => record.kind === "COMPONENT").map((record) => ({
    productName: record.item.productName || null,
    version: record.item.version || null,
    architecture: record.item.architecture || null,
    installationTechnology: record.item.installationTechnology || null,
    collectedAt: record.item.collectedAt || null
  }));
  return {
    products,
    components,
    uncorrelatedLicenseRecords,
    summary: { productCount: products.length, componentCount: components.length, licenseRecordCount: licenses.length }
  };
}

module.exports = { classifyRecord, identity, normalizeOfficeInstallations };
