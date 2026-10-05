const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const prisma = require("../prisma");
const { getCertificadosClientesPath } = require("../config");

const MAX_DEPTH = 3;
const SUPPORTED_EXTENSIONS = new Set([".pfx", ".p12"]);
const EXCLUDED_DIRECTORY_NAME = ".lixeira";
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const VALIDITY_TIME_ZONE = "America/Sao_Paulo";
const MAX_MTIME_FUTURE_MS = 24 * 60 * 60 * 1000;
let scanInProgress = false;

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeExtension(value) {
  return String(value || "").replace(/\.(?:pfx|p12)$/i, "");
}

function removeCredentialMarker(value) {
  const text = String(value || "");
  const marker = /senha|password|pwd/gi;
  let match;
  while ((match = marker.exec(text))) {
    const previous = match.index === 0 ? "" : text[match.index - 1];
    const suffix = text.slice(match.index + match[0].length);
    const separated = match.index === 0 || /[\s_.:,;!?()[\]{}\/\\-]/.test(previous);
    const attachedCredential = /^(?:\d{2,}|[=:]|[\s_.:,;!?()[\]{}\/\\-]+(?:\d|[A-Za-z]*\d))/.test(suffix);
    if (separated || attachedCredential) return text.slice(0, match.index).trim();
  }
  return text.trim();
}

function removeValiditySuffix(value) {
  const marker = /(?:^|[\s_.:,;!?()[\]{}\/\\-])(?:validade|válido|valido|vencido|vence|venc|valid)(?=$|[\s_.:,;!?()[\]{}\/\\-])/giu;
  let match;
  while ((match = marker.exec(value))) {
    if (/\d/.test(value.slice(match.index + match[0].length))) return value.slice(0, match.index).trim();
  }
  return value.trim();
}

function removeDocumentReferences(value) {
  return value
    .replace(/\d{3}[.\s-]\d{3}[.\s-]\d{3}[.\s-]\d{2}/g, " ")
    .replace(/\d{2}[.\s-]\d{3}[.\s-]\d{3}[\/.\s-]\d{4}[.\s-]\d{2}/g, " ")
    .replace(/(?<!\d)(?:\d{11}|\d{14})(?!\d)/g, " ")
    .replace(/(?<!\d)\d{6,}(?!\d)/g, " ");
}

function removeNumericDocumentRoot(value, document) {
  const root = /^\s*(?:(\d{2})[\s._-](\d{3})[\s._-](\d{3})|(\d{8}))(?=\s|[._-]|$)/;
  const match = value.match(root);
  if (!match) return value;
  const digits = match[4] || `${match[1]}${match[2]}${match[3]}`;
  const matchesDocument = document && document.value && document.value.startsWith(digits);
  const followedByBusinessName = /[A-Za-zÀ-ÿ]/.test(value.slice(match[0].length));
  if (matchesDocument || followedByBusinessName) return value.slice(match[0].length).trim();
  return value;
}

function sanitizePublicBusinessName(filename, document = null) {
  let cleaned = removeExtension(filename);
  cleaned = removeCredentialMarker(cleaned);
  cleaned = removeValiditySuffix(cleaned);
  cleaned = removeNumericDocumentRoot(cleaned, document);
  cleaned = removeDocumentReferences(cleaned);
  cleaned = cleaned.replace(/^\s*\d{3}(?=[\s_.-]+)/, " ");
  cleaned = cleaned
    .replace(/[_.\/:\\|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { name: cleaned || "Certificado de cliente", reviewRequired: !cleaned };
}

function cleanDisplayName(filename) {
  return sanitizePublicBusinessName(filename).name;
}

function isValidCivilDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

function civilDateToDate(year, month, day) {
  return isValidCivilDate(year, month, day) ? new Date(Date.UTC(year, month - 1, day, 12, 0, 0)) : null;
}

function datePartsInTimeZone(value, timeZone = VALIDITY_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const result = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return isValidCivilDate(result.year, result.month, result.day) ? result : null;
}

function addCalendarYear(value) {
  const parts = datePartsInTimeZone(value);
  if (!parts) return null;
  const day = Math.min(parts.day, new Date(Date.UTC(parts.year + 1, parts.month, 0)).getUTCDate());
  return civilDateToDate(parts.year + 1, parts.month, day);
}

function currentCivilDate(now = new Date()) {
  const parts = datePartsInTimeZone(now);
  return parts ? civilDateToDate(parts.year, parts.month, parts.day) : null;
}

function isPastCivilDate(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const today = currentCivilDate(now);
  return Boolean(date && today && date.getTime() < today.getTime());
}

function parseExplicitValidity(filename, now = new Date()) {
  const text = String(filename || "");
  const marker = /(?:^|[^A-Za-z0-9À-ÿ])(?:validade|vencimento)(?:[\s_.:,;!?()[\]{}\/\\-]+)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/giu;
  const matches = [];
  let match;
  while ((match = marker.exec(text))) {
    const date = civilDateToDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (date) matches.push(date);
  }
  const unique = [...new Map(matches.map((date) => [date.toISOString().slice(0, 10), date])).values()];
  if (unique.length > 1) return { date: null, status: "AMBIGUA", origin: "AMBIGUA" };
  if (unique.length === 1) return { date: unique[0], status: isPastCivilDate(unique[0], now) ? "VENCIDO_CONFIRMADO" : "VALIDO_CONFIRMADO", origin: "CONFIRMADA_NOME" };
  return null;
}

function extractValidityMetadata(filename, modifiedAt, now = new Date()) {
  const explicit = parseExplicitValidity(filename, now);
  if (explicit) return { validade: explicit.date, validadeOrigem: explicit.origin, validadeStatus: explicit.status };
  const mtime = modifiedAt instanceof Date ? modifiedAt : new Date(modifiedAt);
  if (!Number.isFinite(mtime.getTime()) || mtime.getTime() > now.getTime() + MAX_MTIME_FUTURE_MS) return { validade: null, validadeOrigem: "NAO_IDENTIFICADA", validadeStatus: "NAO_IDENTIFICADA" };
  const estimated = addCalendarYear(mtime);
  if (!estimated) return { validade: null, validadeOrigem: "NAO_IDENTIFICADA", validadeStatus: "NAO_IDENTIFICADA" };
  return { validade: estimated, validadeOrigem: "ESTIMADA_MODIFICACAO", validadeStatus: isPastCivilDate(estimated, now) ? "POSSIVELMENTE_VENCIDO" : "VALIDADE_ESTIMADA" };
}

function validityStatus(record, now = new Date()) {
  const stored = record && record.validadeStatus;
  if (stored === "VALIDO_CONFIRMADO" && record.validade && isPastCivilDate(record.validade, now)) return "VENCIDO_CONFIRMADO";
  if (stored === "VALIDADE_ESTIMADA" && record.validade && isPastCivilDate(record.validade, now)) return "POSSIVELMENTE_VENCIDO";
  return stored || "NAO_IDENTIFICADA";
}

function isConfirmedExpired(record, now = new Date()) {
  return validityStatus(record, now) === "VENCIDO_CONFIRMADO";
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidCpf(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 11 || /^([0-9])\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(digits[i]) * (10 - i);
  let check = (sum * 10) % 11;
  if (check === 10) check = 0;
  if (check !== Number(digits[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i += 1) sum += Number(digits[i]) * (11 - i);
  check = (sum * 10) % 11;
  if (check === 10) check = 0;
  return check === Number(digits[10]);
}

function isValidCnpj(value) {
  const digits = onlyDigits(value);
  if (digits.length !== 14 || /^([0-9])\1+$/.test(digits)) return false;
  const calculate = (length) => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((total, weight, index) => total + Number(digits[index]) * weight, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculate(12) === Number(digits[12]) && calculate(13) === Number(digits[13]);
}

function extractDocument(filename) {
  const stem = removeCredentialMarker(removeExtension(filename));
  const candidates = stem.match(/(?<!\d)\d{11}(?!\d)|(?<!\d)\d{14}(?!\d)|\d{3}\.\d{3}\.\d{3}-\d{2}|\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || [];
  for (const candidate of candidates) {
    const digits = onlyDigits(candidate);
    if (digits.length === 11 && isValidCpf(digits)) return { value: digits, type: "CPF" };
    if (digits.length === 14 && isValidCnpj(digits)) return { value: digits, type: "CNPJ" };
  }
  return { value: null, type: null };
}

function maskDocument(value, type) {
  const digits = onlyDigits(value);
  if (type === "CPF" && digits.length === 11) return `${digits.slice(0, 3)}.***.***-**`;
  if (type === "CNPJ" && digits.length === 14) return `${digits.slice(0, 2)}.***.***/****-**`;
  return null;
}

function buildOriginKey(relativePath) {
  return crypto.createHash("sha256").update(`certificados-clientes\0${relativePath.toLowerCase()}`, "utf8").digest("hex");
}

function parseLogicalFolder(relativeDirectory) {
  const folder = relativeDirectory ? path.basename(relativeDirectory) : null;
  const match = folder && folder.match(/\b(19|20)\d{2}\b/);
  return { pastaLogica: folder, anoReferencia: match ? Number(match[0]) : null };
}

function readRootPath() {
  const configured = getCertificadosClientesPath();
  if (!configured || !path.isAbsolute(configured)) {
    const error = new Error("Raiz de certificados não configurada.");
    error.code = "CERTIFICATE_ROOT_NOT_CONFIGURED";
    throw error;
  }
  const root = path.resolve(configured);
  let stats;
  try {
    stats = fs.lstatSync(root);
  } catch {
    const error = new Error("Raiz de certificados indisponível.");
    error.code = "CERTIFICATE_ROOT_UNAVAILABLE";
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    const error = new Error("Raiz de certificados inválida.");
    error.code = "CERTIFICATE_ROOT_INVALID";
    throw error;
  }
  return root;
}

function makeRecord(root, currentDirectory, entry, stats) {
  const relative = path.relative(root, path.join(currentDirectory, entry.name)).split(path.sep).join("/");
  const relativeDirectory = path.dirname(relative) === "." ? "" : path.dirname(relative).split(path.sep).join("/");
  const document = extractDocument(entry.name);
  const logical = parseLogicalFolder(relativeDirectory);
  const extension = path.extname(entry.name).toLowerCase();
  const validity = extractValidityMetadata(entry.name, stats.mtime);
  const publicName = sanitizePublicBusinessName(entry.name, document);
  return {
    nomeExibicao: publicName.name,
    nomePesquisaNormalizado: normalizeSearchText(publicName.name),
    documentoNormalizado: document.value,
    tipoDocumento: document.type,
    extensao: extension,
    pastaLogica: logical.pastaLogica,
    anoReferencia: logical.anoReferencia,
    tamanhoBytes: stats.size,
    modificadoEm: stats.mtime,
    validade: validity.validade,
    validadeOrigem: validity.validadeOrigem,
    validadeStatus: validity.validadeStatus,
    origemChave: buildOriginKey(relative),
    metadataStatus: publicName.reviewRequired ? "REVISAO_NOME" : "PENDENTE"
  };
}

function scanCatalog(root) {
  const records = [];
  let ignored = 0;
  const ignoredReasons = [];
  const errors = [];

  function visit(directory, depth) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      errors.push("directory_read_failed");
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        ignored += 1;
        errors.push("reparse_point_ignored");
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === EXCLUDED_DIRECTORY_NAME) {
          ignoredReasons.push("excluded_directory");
          continue;
        }
        if (depth >= MAX_DEPTH) {
          errors.push("max_depth_reached");
          continue;
        }
        visit(fullPath, depth + 1);
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extension)) {
        ignored += 1;
        continue;
      }
      try {
        const stats = fs.lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          ignored += 1;
          errors.push("reparse_point_ignored");
          continue;
        }
        records.push(makeRecord(root, directory, entry, stats));
      } catch {
        errors.push("file_metadata_failed");
      }
    }
  }

  visit(root, 0);
  return { records, ignored, ignoredReasons, errors };
}

async function syncCatalog({ db = prisma, rootPath } = {}) {
  if (scanInProgress) {
    const error = new Error("Sincronização de certificados já está em andamento.");
    error.code = "CERTIFICATE_SCAN_IN_PROGRESS";
    throw error;
  }
  scanInProgress = true;
  try {
    const root = rootPath ? validateTestRoot(rootPath) : readRootPath();
    const scan = scanCatalog(root);
    let created = 0;
    let updated = 0;
    for (const record of scan.records) {
      const existing = await db.certificado.findUnique({ where: { origemChave: record.origemChave }, select: { id: true, ativo: true } });
      await db.certificado.upsert({
        where: { origemChave: record.origemChave },
        create: record,
        update: { ...record, ativo: true }
      });
      if (existing) updated += 1;
      else created += 1;
    }
    let inactivated = 0;
    if (scan.errors.length === 0) {
      const active = await db.certificado.findMany({ where: { ativo: true }, select: { id: true, origemChave: true } });
      const current = new Set(scan.records.map((record) => record.origemChave));
      const missing = active.filter((record) => !current.has(record.origemChave)).map((record) => record.id);
      if (missing.length > 0) {
        const result = await db.certificado.updateMany({ where: { id: { in: missing } }, data: { ativo: false } });
        inactivated = result.count;
      }
    }
    return { encontrados: scan.records.length, criados: created, atualizados: updated, inativados: inactivated, ignorados: scan.ignored, erros: scan.errors.length };
  } finally {
    scanInProgress = false;
  }
}

function validateTestRoot(rootPath) {
  const root = path.resolve(String(rootPath || ""));
  let stats;
  try { stats = fs.lstatSync(root); } catch { throw Object.assign(new Error("Raiz de certificados indisponível."), { code: "CERTIFICATE_ROOT_UNAVAILABLE" }); }
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw Object.assign(new Error("Raiz de certificados inválida."), { code: "CERTIFICATE_ROOT_INVALID" });
  return root;
}

function parseListQuery(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page || "1", 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));
  const year = query.ano === undefined || query.ano === "" ? null : Number.parseInt(query.ano, 10);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) throw Object.assign(new Error("Ano inválido."), { code: "INVALID_QUERY" });
  const q = String(query.q || "").trim().slice(0, 120);
  const normalized = normalizeSearchText(q);
  const document = onlyDigits(q);
  return { page, pageSize, year, normalized, document };
}

function publicCertificate(record) {
  return {
    id: record.id,
    nomeExibicao: record.nomeExibicao,
    nomeEmpresa: record.nomeExibicao,
    documento: maskDocument(record.documentoNormalizado, record.tipoDocumento),
    extensao: record.extensao,
    pastaLogica: record.pastaLogica,
    anoReferencia: record.anoReferencia,
    validadeInicio: null,
    validadeFim: record.validade || null,
    validadeOrigem: record.validadeOrigem || "NAO_IDENTIFICADA",
    statusValidade: validityStatus(record),
    metadataStatus: record.metadataStatus
  };
}

async function listCertificates({ db = prisma, query = {}, includeConfirmedExpired = false } = {}) {
  const parsed = parseListQuery(query);
  const where = { ativo: true };
  const today = currentCivilDate();
  const validityFilter = { OR: [{ validadeStatus: null }, { validadeStatus: { notIn: ["VALIDO_CONFIRMADO", "VENCIDO_CONFIRMADO"] } }, { validadeStatus: "VALIDO_CONFIRMADO", validade: { gte: today } }] };
  if (!includeConfirmedExpired) where.AND = [validityFilter];
  if (parsed.year !== null) where.anoReferencia = parsed.year;
  if (parsed.normalized) {
    where.OR = [
      { nomePesquisaNormalizado: { contains: parsed.normalized } },
      ...(parsed.document ? [{ documentoNormalizado: { contains: parsed.document } }] : [])
    ];
  }
  const [total, records] = await Promise.all([
    db.certificado.count({ where }),
    db.certificado.findMany({ where, orderBy: [{ nomeExibicao: "asc" }, { id: "asc" }], skip: (parsed.page - 1) * parsed.pageSize, take: parsed.pageSize })
  ]);
  return { items: records.map(publicCertificate), total, page: parsed.page, pageSize: parsed.pageSize, totalPages: Math.ceil(total / parsed.pageSize) };
}

async function getCertificate(id, db = prisma) {
  const value = Number(id);
  if (!Number.isInteger(value) || value <= 0) throw Object.assign(new Error("ID inválido."), { code: "INVALID_ID" });
  const record = await db.certificado.findFirst({ where: { id: value, ativo: true } });
  return record ? publicCertificate(record) : null;
}

function safeStorageErrorCode(error) {
  const allowed = new Set(["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EHOSTUNREACH", "ETIMEDOUT", "UNKNOWN"]);
  return allowed.has(error && error.code) ? error.code : "UNKNOWN";
}

async function checkStorageAccess({ configuredPath = getCertificadosClientesPath(), fsModule = fs } = {}) {
  const result = {
    configurationPresent: false,
    pathRecognized: false,
    pathReachable: false,
    isDirectory: false,
    readAccess: false,
    errorCode: null
  };
  const value = String(configuredPath || "").trim();
  result.configurationPresent = value.length > 0;
  if (!result.configurationPresent) {
    result.errorCode = "CONFIG_NOT_SET";
    return result;
  }
  if (!path.isAbsolute(value)) {
    result.errorCode = "CONFIG_PATH_INVALID";
    return result;
  }
  result.pathRecognized = true;

  let stats;
  try {
    stats = await fsModule.promises.stat(value);
    result.pathReachable = true;
  } catch (error) {
    result.errorCode = safeStorageErrorCode(error);
    return result;
  }
  result.isDirectory = stats.isDirectory();
  if (!result.isDirectory) {
    result.errorCode = "ENOTDIR";
    return result;
  }
  try {
    await fsModule.promises.access(value, fsModule.constants.R_OK);
    result.readAccess = true;
  } catch (error) {
    result.errorCode = safeStorageErrorCode(error);
  }
  return result;
}

module.exports = {
  MAX_DEPTH,
  EXCLUDED_DIRECTORY_NAME,
  SUPPORTED_EXTENSIONS,
  normalizeSearchText,
  removeExtension,
  removeCredentialMarker,
  removeValiditySuffix,
  removeDocumentReferences,
  removeNumericDocumentRoot,
  sanitizePublicBusinessName,
  cleanDisplayName,
  isValidCpf,
  isValidCnpj,
  extractDocument,
  maskDocument,
  buildOriginKey,
  scanCatalog,
  syncCatalog,
    listCertificates,
    getCertificate,
    checkStorageAccess,
    publicCertificate,
    parseExplicitValidity,
    extractValidityMetadata,
    addCalendarYear,
    isValidCivilDate,
    validityStatus,
    isConfirmedExpired,
    VALIDITY_TIME_ZONE,
  _resetScanLockForTests: () => { scanInProgress = false; }
};
