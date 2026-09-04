const { normalizeCpuForExcel, normalizeOfficeForExcel } = require("./excelSyncWriter");
const { normalizeOfficeInstallations } = require("./officeNormalization");

const TECHNICAL_COLUMNS = ["B", "C", "D", "G", "I", "J"];

function canonicalText(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/\s+/g, "").trim();
}

function canonicalWindows(value) {
  const normalized = canonicalText(value).replace(/[^a-z0-9.]/g, "");
  const family = /(?:windows)?(10|11)(?:\.0)?/.exec(normalized);
  return family ? `windows${family[1]}` : normalized;
}

function canonicalStorage(value) {
  const match = String(value == null ? "" : value).replace(",", ".").match(/(\d+(?:\.\d+)?)\s*(GB|TB)/i);
  if (!match) return canonicalText(value);
  const gb = Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1000 : 1);
  return Number.isFinite(gb) ? String(Math.round(gb)) : canonicalText(value);
}

function canonicalOffice(value) {
  const normalized = canonicalText(value);
  if (/365|microsoft365|o365/.test(normalized)) return "microsoft365";
  const year = /(2013|2016|2019|2021|2024)/.exec(normalized);
  return year ? `office${year[1]}` : normalized;
}

function comparisonValues(values) {
  const result = {};
  if (values.B !== undefined) result.B = normalizeCpuForExcel(values.B).toLowerCase().replace(/\s+/g, " ").trim();
  if (values.C !== undefined) result.C = canonicalStorage(values.C);
  if (values.D !== undefined) result.D = canonicalWindows(values.D);
  if (values.G !== undefined) result.G = canonicalStorage(values.G);
  if (values.I !== undefined) result.I = String(values.I || "").slice(-5).toUpperCase();
  if (values.J !== undefined) result.J = canonicalOffice(values.J);
  return result;
}

function snapshot(values) {
  const filtered = Object.fromEntries(Object.entries(values).filter(([column]) => TECHNICAL_COLUMNS.includes(column)));
  return { values: filtered, comparison: comparisonValues(filtered) };
}

function snapshotFromBaseline(baseline) {
  return snapshot({
    B: baseline.processadorEsperado,
    C: `${Math.round(Number(baseline.ramEsperada))} GB`,
    D: baseline.windowsEsperado,
    G: baseline.armazenamentoEsperado,
    I: baseline.officePartialKeyEsperada || "",
    J: normalizeOfficeForExcel(baseline.officeEsperado || "")
  });
}

function snapshotFromComputer(computer, { includeOffice = false, includeStorage = true } = {}) {
  const capacities = (Array.isArray(computer?.discosFisicos) ? computer.discosFisicos : [])
    .map((disk) => Number(disk.tamanho)).filter((size) => Number.isFinite(size) && size > 0);
  const ram = Number(computer?.ramTotal);
  const processor = String(computer?.processador || "").trim();
  const windows = String(computer?.sistemaRelease || computer?.sistema || "").trim();
  if (!processor || !Number.isFinite(ram) || ram <= 0 || !windows || !capacities.length) return null;
  const values = {
    B: normalizeCpuForExcel(processor),
    C: `${Math.round(ram / (1024 ** 3))} GB`,
    D: windows
  };
  if (includeStorage) values.G = `${Math.round(Math.max(...capacities) / 1e9)} GB`;
  if (includeOffice) {
    const office = normalizeOfficeInstallations(computer.officeInstallations || []);
    const product = office.products[0] || null;
    values.I = product?.primaryLicense?.partialProductKey || "";
    values.J = normalizeOfficeForExcel(product?.productName || "");
  }
  return snapshot(values);
}

function snapshotsEqual(left, right) {
  if (!left || !right) return false;
  const a = left.comparison || comparisonValues(left.values || {});
  const b = right.comparison || comparisonValues(right.values || {});
  return Object.keys(b).every((key) => a[key] === b[key]);
}

function mergeSnapshots(left, right) {
  const values = { ...(left?.values || {}), ...(right?.values || {}) };
  return snapshot(values);
}

module.exports = { TECHNICAL_COLUMNS, mergeSnapshots, snapshot, snapshotFromBaseline, snapshotFromComputer, snapshotsEqual };
