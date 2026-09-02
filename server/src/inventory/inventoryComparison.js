const { normalizeOfficeInstallations } = require("./officeNormalization");

const STATUS = { MATCH: "MATCH", DIFFERENT: "DIFFERENT", NO_BASELINE: "NO_BASELINE", NO_AGENT_DATA: "NO_AGENT_DATA", NOT_COMPARABLE: "NOT_COMPARABLE" };

function clean(value) {
  return String(value || "").toLowerCase().replace(/\(r\)|\(tm\)|\(c\)/g, "").replace(/\bcpu\b|@.*$/g, "").replace(/[^a-z0-9]+/g, "").trim();
}

function compareCpu(expected, actual) {
  if (!expected) return { status: STATUS.NO_BASELINE, reason: "baseline_missing" };
  if (!actual) return { status: STATUS.NO_AGENT_DATA, reason: "agent_cpu_missing" };
  return { status: clean(expected) === clean(actual) ? STATUS.MATCH : STATUS.DIFFERENT, reason: "normalized_cpu_comparison" };
}

function numberValue(value) {
  const match = String(value || "").replace(",", ".").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function compareRam(expected, actualBytes) {
  if (expected == null) return { status: STATUS.NO_BASELINE, reason: "baseline_missing" };
  if (actualBytes == null) return { status: STATUS.NO_AGENT_DATA, reason: "agent_ram_missing" };
  const expectedGb = numberValue(expected);
  const actualGb = Number(actualBytes) / (1024 ** 3);
  if (!Number.isFinite(expectedGb) || !Number.isFinite(actualGb)) return { status: STATUS.NOT_COMPARABLE, reason: "invalid_ram_value" };
  return { status: Math.round(expectedGb) === Math.round(actualGb) ? STATUS.MATCH : STATUS.DIFFERENT, reason: "rounded_gb_comparison", actualGb };
}

function compareStorage(expected, disks) {
  if (!expected) return { status: STATUS.NOT_COMPARABLE, reason: "unstructured_storage_baseline" };
  if (!Array.isArray(disks) || !disks.length) return { status: STATUS.NO_AGENT_DATA, reason: "agent_storage_missing" };
  const expectedGb = numberValue(expected);
  if (!expectedGb) return { status: STATUS.NOT_COMPARABLE, reason: "storage_capacity_missing" };
  const actualGb = disks.map((disk) => Number(disk.tamanho) / 1e9).filter(Number.isFinite);
  if (!actualGb.length) return { status: STATUS.NO_AGENT_DATA, reason: "agent_storage_size_missing" };
  const match = actualGb.some((value) => Math.abs(value - expectedGb) / expectedGb <= 0.08);
  return { status: match ? STATUS.MATCH : STATUS.DIFFERENT, reason: "commercial_capacity_tolerance" };
}

function windowsFamily(value) {
  const match = String(value || "").match(/windows\s*(10|11)|\b(10|11)\.0/mi);
  return match ? Number(match[1] || match[2]) : null;
}

function compareWindows(expected, actual, release) {
  if (!expected) return { status: STATUS.NO_BASELINE, reason: "baseline_missing" };
  const expectedFamily = windowsFamily(expected);
  const actualFamily = windowsFamily(actual) || windowsFamily(release);
  if (!actualFamily) return { status: STATUS.NO_AGENT_DATA, reason: "agent_windows_family_missing" };
  if (!expectedFamily) return { status: STATUS.NOT_COMPARABLE, reason: "windows_family_missing" };
  return { status: expectedFamily === actualFamily ? STATUS.MATCH : STATUS.DIFFERENT, reason: "windows_family_comparison" };
}

function officeIdentity(value) {
  const text = String(value || "").toLowerCase();
  if (/365|microsoft 365/.test(text)) return "MICROSOFT_365";
  if (/2013|office 15/.test(text)) return "OFFICE_2013";
  if (/2016/.test(text)) return "OFFICE_2016";
  if (/2019/.test(text)) return "OFFICE_2019";
  if (/2021/.test(text)) return "OFFICE_2021";
  return null;
}

function compareOffice(expected, actual) {
  if (!expected) return { status: STATUS.NO_BASELINE, reason: "baseline_missing" };
  if (!actual) return { status: STATUS.NO_AGENT_DATA, reason: "agent_office_missing" };
  const expectedId = officeIdentity(expected);
  const actualId = officeIdentity(actual);
  if (!expectedId || !actualId) return { status: STATUS.NOT_COMPARABLE, reason: "office_identity_missing" };
  return { status: expectedId === actualId ? STATUS.MATCH : STATUS.DIFFERENT, reason: "normalized_office_identity" };
}

function comparePartialKey(expected, actual) {
  if (!expected) return { status: STATUS.NO_BASELINE, reason: "baseline_missing" };
  if (!actual) return { status: STATUS.NO_AGENT_DATA, reason: "agent_office_key_missing" };
  return { status: String(expected).slice(-5).toUpperCase() === String(actual).slice(-5).toUpperCase() ? STATUS.MATCH : STATUS.DIFFERENT, reason: "case_insensitive_partial_key" };
}

function fieldResult(field, expected, actual, result) {
  return { field, expected: expected == null ? null : String(expected), actual: actual == null ? null : String(actual), status: result.status, reason: result.reason };
}

function compareInventory(baseline, current) {
  if (!baseline) return ["CPU", "RAM", "STORAGE", "WINDOWS", "OFFICE", "OFFICE_PARTIAL_KEY"].map((field) => ({ field, expected: null, actual: null, status: STATUS.NO_BASELINE, reason: "baseline_missing" }));
  const officeInstallations = current && (current.officeInstallations || current.office?.installations);
  const office = officeInstallations ? normalizeOfficeInstallations(officeInstallations) : null;
  const product = office && office.products[0] ? office.products[0] : null;
  const ramActual = current?.ramTotal == null ? null : `${(Number(current.ramTotal) / (1024 ** 3)).toFixed(1)} GB`;
  const storageActual = Array.isArray(current?.discosFisicos) ? current.discosFisicos.map((disk) => Number.isFinite(Number(disk.tamanho)) ? `${(Number(disk.tamanho) / 1e9).toFixed(0)} GB` : disk.modelo).filter(Boolean).join(", ") || null : null;
  return [
    fieldResult("CPU", baseline.processadorEsperado, current?.processador, compareCpu(baseline.processadorEsperado, current?.processador)),
    fieldResult("RAM", baseline.ramEsperada, ramActual, compareRam(baseline.ramEsperada, current?.ramTotal)),
    fieldResult("STORAGE", baseline.armazenamentoEsperado, storageActual, compareStorage(baseline.armazenamentoEsperado, current?.discosFisicos)),
    fieldResult("WINDOWS", baseline.windowsEsperado, current?.sistemaRelease || current?.sistema, compareWindows(baseline.windowsEsperado, current?.sistema, current?.sistemaRelease)),
    fieldResult("OFFICE", baseline.officeEsperado, product?.productName, compareOffice(baseline.officeEsperado, product?.productName)),
    fieldResult("OFFICE_PARTIAL_KEY", baseline.officePartialKeyEsperada, product?.primaryLicense?.partialProductKey, comparePartialKey(baseline.officePartialKeyEsperada, product?.primaryLicense?.partialProductKey))
  ];
}

module.exports = { STATUS, compareCpu, compareRam, compareStorage, compareWindows, compareOffice, comparePartialKey, compareInventory };
