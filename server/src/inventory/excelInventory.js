const fs = require("fs");
const { unzipSync, strFromU8 } = require("fflate");
const { getInventoryExcelPath } = require("../config");

const FULL_KEY_RE = /^[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}$/;
const FULL_KEY_ANYWHERE_RE = /\b[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{5}){4}\b/;

function text(value) {
  return value == null ? "" : String(value).trim();
}

function safeText(value) {
  const result = text(value);
  return FULL_KEY_ANYWHERE_RE.test(result) ? "" : result;
}

function normalizeEquipmentNumber(value) {
  const match = text(value).match(/^(\d+)\.?$/);
  return match ? match[1] : null;
}

function partialOfficeKey(value) {
  const raw = text(value);
  if (FULL_KEY_RE.test(raw)) return raw.slice(-5);
  return /^[A-Za-z0-9]{5}$/.test(raw) ? raw : null;
}

function sanitizeInventoryRow(row) {
  const ram = text(row[" RAM"]);
  return {
    equipamentoNumero: normalizeEquipmentNumber(row["EQUIP. Nº"] ?? row["EQUIP. N°"]),
    processador: safeText(row.PROCESSADOR) || null,
    ramEsperada: ram && Number.isFinite(Number(ram)) ? Number(ram) : null,
    windowsEsperado: safeText(row["SISTEMA OPERACIONAL"]) || null,
    fabricanteModeloEsperado: safeText(row.marca) || null,
    apelidoEsperado: safeText(row.atual) || null,
    armazenamentoEsperado: safeText(row["OBSERVAÇÕES"]) || null,
    observacoes: safeText(row["OBSERVAÇÕES"]) || null,
    officePartialKeyEsperada: partialOfficeKey(row["OFFICE KEY"]),
    officeEsperado: safeText(row.OFFICE) || null
  };
}

function decodeXml(value) {
  return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function sharedStrings(xml) {
  return Array.from(String(xml || "").matchAll(/<si[\s\S]*?<\/si>/g), (match) => Array.from(match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g), (part) => decodeXml(part[1])).join(""));
}

function sheetPath(workbookXml, relationsXml) {
  const sheet = /<sheet\s+[^>]*name="INVENTARIO"[^>]*r:id="([^"]+)"/i.exec(workbookXml) || /<sheet\s+[^>]*r:id="([^"]+)"[^>]*name="INVENTARIO"/i.exec(workbookXml);
  const relationId = sheet && sheet[1];
  const relation = relationId && new RegExp(`<Relationship[^>]*Id="${relationId}"[^>]*Target="([^"]+)"`, "i").exec(relationsXml);
  const target = relation ? relation[1].replace(/^\/+/, "") : "worksheets/sheet1.xml";
  return target.startsWith("xl/") ? target : `xl/${target}`;
}

function parseSheetRows(xml, strings) {
  return Array.from(String(xml || "").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g), (rowMatch) => {
    const values = {};
    for (const cell of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cell[1];
      const ref = /\br="([A-Z]+\d+)"/i.exec(attributes);
      if (!ref) continue;
      const value = /<v[^>]*>([\s\S]*?)<\/v>/i.exec(cell[2]);
      const inline = /<t[^>]*>([\s\S]*?)<\/t>/i.exec(cell[2]);
      let result = value ? decodeXml(value[1]) : inline ? decodeXml(inline[1]) : "";
      if (/\bt="s"/.test(attributes) && strings[Number(result)] !== undefined) result = strings[Number(result)];
      values[ref[1].replace(/\d+$/, "")] = result;
    }
    return values;
  });
}

function readInventoryRows(filePath = getInventoryExcelPath()) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(filePath)));
  const workbookXml = strFromU8(files["xl/workbook.xml"] || new Uint8Array());
  const relationsXml = strFromU8(files["xl/_rels/workbook.xml.rels"] || new Uint8Array());
  const strings = sharedStrings(strFromU8(files["xl/sharedStrings.xml"] || new Uint8Array()));
  const rows = parseSheetRows(strFromU8(files[sheetPath(workbookXml, relationsXml)] || new Uint8Array()), strings);
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => sanitizeInventoryRow(Object.fromEntries(Object.entries(row).map(([column, value]) => [headers[column] || column, value]))));
}

module.exports = { FULL_KEY_RE, normalizeEquipmentNumber, partialOfficeKey, sanitizeInventoryRow, readInventoryRows };
