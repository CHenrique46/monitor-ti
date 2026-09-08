const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { unzipSync, zipSync, strFromU8, strToU8 } = require("fflate");
const { FULL_KEY_RE, normalizeEquipmentNumber, normalizeIpv4, parseSheetRows, readInventoryRows, sheetPath } = require("./excelInventory");
const { normalizeCpu } = require("./inventoryComparison");
const { getInventoryExcelPath } = require("../config");

const SYNC_OPERATION = "UPSERT_INVENTORY";
const AUTHORIZED_COLUMNS = new Set(["B", "C", "D", "G", "I", "J"]);
const PRESERVED_COLUMNS = new Set(["A", "E", "F", "H", "K"]);
const OFFICE_PARTIAL_KEY_RE = /^[A-Za-z0-9]{5}$/;
const OFFICE_ACCOUNT_RE = /^(?:[^@\s]+\s+[-:]\s+)?[^@\s]+@[^@\s]+\.[^@\s]+$/;

class ExcelSyncError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExcelSyncError";
    this.code = code;
  }
}

function xmlEscape(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function attrValue(attributes, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`, "i").exec(attributes);
  return match ? match[1] : "";
}

function decodeXml(value) {
  return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function sharedStringValues(xml) {
  return Array.from(String(xml || "").matchAll(/<si[\s\S]*?<\/si>/g), (match) => Array.from(match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g), (part) => decodeXml(part[1])).join(""));
}

function cellRecords(rowXml, strings) {
  const records = [];
  let cursor = 0;
  while (true) {
    const start = rowXml.indexOf("<c", cursor);
    if (start < 0) break;
    const openingEnd = rowXml.indexOf(">", start);
    if (openingEnd < 0) break;
    const opening = rowXml.slice(start, openingEnd + 1);
    const attributes = opening.slice(2, -1);
    const selfClosing = attributes.trimEnd().endsWith("/");
    const end = selfClosing ? openingEnd + 1 : rowXml.indexOf("</c>", openingEnd + 1) + 4;
    if (end < openingEnd + 1) break;
    const raw = rowXml.slice(start, end);
    const content = selfClosing ? "" : rowXml.slice(openingEnd + 1, end - 4);
    const ref = attrValue(attributes, "r");
    const type = attrValue(attributes, "t");
    const valueMatch = /<v[^>]*>([\s\S]*?)<\/v>/i.exec(content);
    const inlineMatch = /<t[^>]*>([\s\S]*?)<\/t>/i.exec(content);
    let value = valueMatch ? decodeXml(valueMatch[1]) : inlineMatch ? decodeXml(inlineMatch[1]) : "";
    if (type === "s" && strings[Number(value)] !== undefined) value = strings[Number(value)];
    records.push({ start, end, ref, column: ref.replace(/\d+$/, ""), value, raw, attributes, selfClosing });
    cursor = end;
  }
  return records;
}

function normalizeCpuForExcel(value) {
  const raw = String(value || "").replace(/\(R\)|\(TM\)|\(C\)/gi, "").replace(/\s+CPU\b.*$/i, "").replace(/\s*@.*$/i, "").replace(/\s+/g, " ").trim();
  return raw || normalizeCpu(value);
}

function normalizeRamForExcel(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new ExcelSyncError("INVALID_BASELINE", "RAM do baseline inválida.");
  return `${Math.round(amount)} GB`;
}

function normalizeStorageForExcel(value) {
  const match = String(value || "").trim().match(/^(\d+(?:[.,]\d+)?)\s*(GB|TB)$/i);
  if (!match) throw new ExcelSyncError("INVALID_BASELINE", "Armazenamento do baseline inválido.");
  return `${Number(match[1].replace(",", "."))} ${match[2].toUpperCase()}`;
}

function normalizeOfficeForExcel(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const year = /\b(2013|2016|2019|2021|2024)\b/.exec(raw);
  if (year && /HOME\s*(AND|&)\s*BUSINESS|HOME BUSINESS|HOMEBUSINESS/i.test(raw)) return `${year[1]} H B`;
  return raw;
}

function baselineValues(baseline, snapshot) {
  if (!baseline || !baseline.equipamentoNumero) throw new ExcelSyncError("INVALID_BASELINE", "Baseline inválido.");
  const snapshotValues = snapshot && snapshot.values ? snapshot.values : snapshot || {};
  const hasSnapshot = snapshot !== undefined && snapshot !== null;
  const partial = String(baseline.officePartialKeyEsperada || "").toUpperCase();
  if (partial && !OFFICE_PARTIAL_KEY_RE.test(partial)) throw new ExcelSyncError("INVALID_BASELINE", "Partial Office inválida.");
  return {
    A: String(baseline.equipamentoNumero),
    B: snapshotValues.B !== undefined ? String(snapshotValues.B) : (hasSnapshot ? undefined : normalizeCpuForExcel(baseline.processadorEsperado)),
    C: snapshotValues.C !== undefined ? String(snapshotValues.C) : (hasSnapshot ? undefined : normalizeRamForExcel(baseline.ramEsperada)),
    D: snapshotValues.D !== undefined ? String(snapshotValues.D).trim() : (hasSnapshot ? undefined : String(baseline.windowsEsperado || "").trim()),
    G: snapshotValues.G !== undefined ? String(snapshotValues.G) : (hasSnapshot ? undefined : normalizeStorageForExcel(baseline.armazenamentoEsperado)),
    I: snapshotValues.I !== undefined ? String(snapshotValues.I || "").slice(-5).toUpperCase() : (hasSnapshot ? undefined : partial),
    J: snapshotValues.J !== undefined ? String(snapshotValues.J || "") : (hasSnapshot ? undefined : normalizeOfficeForExcel(baseline.officeEsperado))
  };
}

function classifyOfficeKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "EMPTY";
  if (OFFICE_PARTIAL_KEY_RE.test(raw) || FULL_KEY_RE.test(raw)) return "PARTIAL_PRODUCT_KEY";
  if (OFFICE_ACCOUNT_RE.test(raw)) return "ACCOUNT_LINKED_LICENSE";
  return "UNKNOWN_LEGACY_VALUE";
}

function officeAction(current, desired) {
  const raw = String(current || "").trim().toUpperCase();
  const classification = classifyOfficeKey(current);
  if (classification === "EMPTY") return desired;
  if (classification === "ACCOUNT_LINKED_LICENSE") return current;
  if (classification === "PARTIAL_PRODUCT_KEY") {
    if (raw === desired) return current;
    if (FULL_KEY_RE.test(raw) && raw.slice(-5) === desired) return current;
    if (OFFICE_PARTIAL_KEY_RE.test(raw)) throw new ExcelSyncError("OFFICE_KEY_CONFLICT", "Office Key parcial existente diverge do baseline.");
    throw new ExcelSyncError("OFFICE_KEY_CONFLICT", "Office Key histórica diverge do baseline.");
  }
  throw new ExcelSyncError("OFFICE_KEY_CONFLICT", "Office Key existente possui formato inválido.");
}

function setCellValue(rawCell, value) {
  const openingEnd = rawCell.indexOf(">");
  const attributes = rawCell.slice(2, openingEnd).replace(/\s+t="[^"]*"/i, "").replace(/\s*\/\s*$/, "");
  return `<c${attributes} t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
}

function setRamCellValue(rawCell, value) {
  const openingEnd = rawCell.indexOf(">"), attributes = rawCell.slice(2, openingEnd).replace(/\s+t="[^"]*"/i, "").replace(/\s*\/\s*$/, "");
  return `<c${attributes}><v>${xmlEscape(String(value).replace(/\s*GB$/i, ""))}</v></c>`;
}

function updateRow(rowXml, rowNumber, values, strings) {
  const records = cellRecords(rowXml, strings);
  const byColumn = new Map(records.map((record) => [record.column, record]));
  const officeCurrent = byColumn.get("I")?.value || "";
  if (values.I !== undefined) values.I = officeAction(officeCurrent, values.I);
  const replacements = [];
  for (const column of AUTHORIZED_COLUMNS) {
    if (values[column] === undefined) continue;
    if (column === "I" && values.I === officeCurrent) continue;
    const record = byColumn.get(column);
    if (record) replacements.push({ start: record.start, end: record.end, value: column === "C" ? setRamCellValue(record.raw, values[column]) : setCellValue(record.raw, values[column]) });
    else replacements.push({ start: rowXml.length, end: rowXml.length, value: `<c r="${column}${rowNumber}" t="inlineStr"><is><t>${xmlEscape(values[column])}</t></is></c>` });
  }
  let result = rowXml;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  return result;
}

function transformWorkbook(buffer, baseline, snapshot, computer) {
  const files = unzipSync(new Uint8Array(buffer));
  const workbookXml = strFromU8(files["xl/workbook.xml"] || new Uint8Array());
  const relationsXml = strFromU8(files["xl/_rels/workbook.xml.rels"] || new Uint8Array());
  const inventoryPath = sheetPath(workbookXml, relationsXml);
  const sheetXml = strFromU8(files[inventoryPath] || new Uint8Array());
  if (!sheetXml) throw new ExcelSyncError("INVENTORY_SHEET_NOT_FOUND", "Sheet INVENTARIO não encontrada.");
  const strings = sharedStringValues(strFromU8(files["xl/sharedStrings.xml"] || new Uint8Array()));
  const parsedRows = parseSheetRows(sheetXml, strings);
  if (!parsedRows.length) throw new ExcelSyncError("INVENTORY_SHEET_EMPTY", "Sheet INVENTARIO vazia.");
  const headers = parsedRows[0];
  const equipmentColumn = Object.keys(headers).find((column) => headers[column] === "EQUIP. N°" || headers[column] === "EQUIP. Nº");
  if (!equipmentColumn) throw new ExcelSyncError("INVENTORY_HEADER_NOT_FOUND", "Header EQUIP. Nº não encontrado.");
  const values = baselineValues(baseline, snapshot);
  const computerIp = normalizeIpv4(computer?.ip);
  if (!computerIp) throw new ExcelSyncError("INVALID_COMPUTER_IP", "IP do computador inválido ou ausente.");
  if (!computer.equipamentoNumero) throw new ExcelSyncError("EQUIPMENT_NUMBER_REQUIRED", "Computador sem equipamentoNumero não pode sincronizar.");
  const rowMatches = [];
  const xmlRows = Array.from(sheetXml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g));
  for (let index = 1; index < parsedRows.length; index++) {
    if (normalizeIpv4(parsedRows[index].K) === computerIp) rowMatches.push(index);
  }
  if (!rowMatches.length) throw new ExcelSyncError("INVENTORY_IP_NOT_FOUND", `IP ${computerIp} não encontrado no Excel.`);
  if (rowMatches.length > 1) throw new ExcelSyncError("DUPLICATE_INVENTORY_IP", `IP ${computerIp} possui linhas duplicadas no Excel.`);
  const rowIndex = rowMatches[0];
  const rowEquipment = normalizeEquipmentNumber(parsedRows[rowIndex][equipmentColumn]);
  if (!rowEquipment || rowEquipment !== String(computer.equipamentoNumero)) throw new ExcelSyncError("IP_EQUIPMENT_MISMATCH", `IP ${computerIp} aponta para equipamento divergente.`);
  const rowXml = xmlRows[rowIndex][0];
  const rowNumber = Number(/\br="[A-Z]+(\d+)"/i.exec(rowXml)?.[1] || rowIndex + 1);
  xmlRows[rowIndex].__replacement = updateRow(rowXml, rowNumber, values, strings);
  let output = "";
  let cursor = 0;
  for (const match of xmlRows) {
    output += sheetXml.slice(cursor, match.index);
    output += match.__replacement || match[0];
    cursor = match.index + match[0].length;
  }
  output += sheetXml.slice(cursor);
  files[inventoryPath] = strToU8(output);
  const result = zipSync(files);
  return { buffer: Buffer.from(result), values };
}

function acquireLock(filePath) {
  const lockPath = `${filePath}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lockPath, "wx"); }
  catch (error) { throw new ExcelSyncError("EXCEL_LOCKED", "Inventário Excel está em uso por outra operação."); }
  return () => { try { fs.closeSync(descriptor); } finally { fs.rmSync(lockPath, { force: true }); } };
}

function nextBackupPath(backupDir, baseName, now) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(backupDir, `${baseName}.${stamp}.bak.xlsx`);
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = path.join(backupDir, `${baseName}.${stamp}.${suffix++}.bak.xlsx`);
  return candidate;
}

function safeError(error) {
  return `${error?.code || "EXCEL_SYNC_ERROR"}: ${String(error?.message || "Falha na sincronização").replace(/[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}/g, "[redacted]").slice(0, 240)}`;
}

function syncBaselineToExcel({ baseline, snapshot, computer, filePath = getInventoryExcelPath(), backupDir = path.join(path.dirname(filePath), "backups"), now = Date.now } = {}) {
  const release = acquireLock(filePath);
  let tempPath;
  try {
    if (!fs.existsSync(filePath)) throw new ExcelSyncError("EXCEL_NOT_FOUND", "Arquivo de inventário não encontrado.");
    const source = fs.readFileSync(filePath);
    const transformed = transformWorkbook(source, baseline, snapshot, computer);
    tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    fs.writeFileSync(tempPath, transformed.buffer, { flag: "wx" });
    const check = readInventoryRows(tempPath).filter((row) => row.equipamentoNumero === String(baseline.equipamentoNumero));
    const writtenOfficePartial = check[0]?.officePartialKeyEsperada || "";
    const expectedOfficePartial = String(transformed.values.I || "").slice(-5);
    const officeIsAccount = classifyOfficeKey(transformed.values.I) === "ACCOUNT_LINKED_LICENSE";
    if (check.length !== 1 || (transformed.values.I !== undefined && !officeIsAccount && writtenOfficePartial !== expectedOfficePartial && writtenOfficePartial !== transformed.values.I) || (transformed.values.G !== undefined && check[0].armazenamentoEsperado !== transformed.values.G)) {
      throw new ExcelSyncError("EXCEL_VALIDATION_FAILED", `Workbook temporário inválido: rows=${check.length}, officePartial=${writtenOfficePartial}, expectedOfficePartial=${expectedOfficePartial}, storage=${check[0]?.armazenamentoEsperado || ""}.`);
    }
    const backupPath = nextBackupPath(backupDir, path.basename(filePath, path.extname(filePath)), now);
    fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tempPath, filePath);
    tempPath = null;
    return { status: "SYNCED", backupPath, equipamentoNumero: transformed.values.A };
  } catch (error) {
    if (error instanceof ExcelSyncError) throw error;
    throw new ExcelSyncError("EXCEL_SYNC_FAILED", safeError(error));
  } finally {
    if (tempPath) fs.rmSync(tempPath, { force: true });
    release();
  }
}

module.exports = { AUTHORIZED_COLUMNS, PRESERVED_COLUMNS, SYNC_OPERATION, ExcelSyncError, baselineValues, classifyOfficeKey, normalizeCpuForExcel, normalizeOfficeForExcel, normalizeRamForExcel, normalizeStorageForExcel, transformWorkbook, syncBaselineToExcel, safeError };
