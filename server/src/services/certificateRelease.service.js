const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildOriginKey, MAX_DEPTH, SUPPORTED_EXTENSIONS, sanitizePublicBusinessName } = require("./certificados.service");
const { getCertificadosClientesPath, getCertificadosLiberadosPath, getCertificadosLiberadosUnc } = require("../config");

function makeError(code, message) { return Object.assign(new Error(message), { code }); }

function isReparsePoint(stats) {
  return Boolean(stats && (stats.isSymbolicLink?.() || stats.isReparsePoint?.()));
}

function assertDirectory(directory, code) {
  let stats;
  try { stats = fs.lstatSync(directory); } catch { throw makeError(code, "Diretório de liberação indisponível."); }
  if (!stats.isDirectory() || isReparsePoint(stats)) throw makeError(code, "Diretório de liberação inválido.");
}

function realDirectory(directory, code) {
  assertDirectory(directory, code);
  try { return fs.realpathSync.native(directory); } catch { throw makeError(code, "Diretório de liberação indisponível."); }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveOrigin(root, originKey) {
  if (!path.isAbsolute(String(root || ""))) throw makeError("RELEASE_SOURCE_INVALID", "A origem do certificado exige revisão.");
  const realRoot = realDirectory(root, "RELEASE_SOURCE_INVALID");
  const matches = [];

  function visit(directory, depth) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let stats;
      try { stats = fs.lstatSync(candidate); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
      if (entry.isSymbolicLink?.() || isReparsePoint(stats)) throw makeError("RELEASE_SOURCE_REPARSE", "A origem do certificado exige revisão.");
      if (stats.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        visit(candidate, depth + 1);
        continue;
      }
      if (!stats.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let realCandidate;
      try { realCandidate = fs.realpathSync.native(candidate); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
      if (!isWithin(realRoot, realCandidate)) throw makeError("RELEASE_SOURCE_TRAVERSAL", "A origem do certificado exige revisão.");
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      if (buildOriginKey(relative) === originKey) matches.push({ candidate, extension: path.extname(entry.name).toLowerCase() });
    }
  }

  visit(root, 0);
  if (matches.length === 0) throw makeError("RELEASE_SOURCE_NOT_FOUND", "O certificado não foi localizado para liberação.");
  if (matches.length > 1) throw makeError("RELEASE_SOURCE_AMBIGUOUS", "A origem do certificado exige revisão.");
  return matches[0];
}

function safePart(value, fallback) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  const upper = normalized.toUpperCase();
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/.test(upper);
  return (reserved ? `CERT-${normalized}` : normalized).slice(0, 64) || fallback;
}

function releaseFilename(request, extension) {
  const publicName = sanitizePublicBusinessName(request.certificado.nomeExibicao).name;
  const year = Number.isInteger(request.certificado.anoReferencia) ? request.certificado.anoReferencia : "CERT";
  const token = String(request.protocolo || crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase();
  return `${safePart(publicName, "CERTIFICADO")}-${year}-SC-${request.id}-${token}${extension}`.slice(0, 180);
}

function destinationInfo(filename, configuredDestination = null) {
  const destination = configuredDestination || getCertificadosLiberadosPath();
  const realDestination = realDirectory(destination, "RELEASE_DESTINATION_INVALID");
  if (path.basename(filename) !== filename || !/^.+\.(?:pfx|p12)$/i.test(filename)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
  const target = path.resolve(destination, filename);
  if (!isWithin(path.resolve(destination), target)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
  return { destination, realDestination, target };
}

function existingReleasedFile(request, configuredDestination = null) {
  if (!request.nomeArquivoLiberado || !request.liberadoEm) return null;
  const info = destinationInfo(request.nomeArquivoLiberado, configuredDestination);
  let stats;
  try { stats = fs.lstatSync(info.target); } catch { return null; }
  if (!stats.isFile() || isReparsePoint(stats)) throw makeError("RELEASE_REVIEW_REQUIRED", "A liberação registrada exige revisão.");
  let realTarget;
  try { realTarget = fs.realpathSync.native(info.target); } catch { throw makeError("RELEASE_REVIEW_REQUIRED", "A liberação registrada exige revisão."); }
  if (!isWithin(info.realDestination, realTarget)) throw makeError("RELEASE_REVIEW_REQUIRED", "A liberação registrada exige revisão.");
  return { ...info, exists: true };
}

async function withDatabaseLock(db, requestId, operation) {
  if (typeof db.$transaction !== "function") return operation(db);
  return db.$transaction(async (tx) => {
    if (typeof tx.$executeRaw === "function") await tx.$executeRaw`SELECT pg_advisory_xact_lock(${requestId})`;
    return operation(tx);
  });
}

function publicRelease(request) {
  if (!request?.liberadoEm || !request?.nomeArquivoLiberado) return null;
  try {
    if (!existingReleasedFile(request)) return null;
    return { nomeArquivoLiberado: request.nomeArquivoLiberado, liberadoEm: request.liberadoEm, compartilhamento: getCertificadosLiberadosUnc() };
  } catch { return null; }
}

function createCertificateReleaseService({ db, fsModule = fs, sourcePath = null, destinationPath = null } = {}) {
  if (!db) throw new Error("Banco de dados obrigatório.");
  const io = fsModule;
  const requestLocks = new Map();
  const blocked = new Set();
  async function releaseRequest(requestId, actor) {
    const id = Number(requestId);
    if (!Number.isInteger(id) || id <= 0) throw makeError("INVALID_ID", "Solicitação inválida.");
    if (blocked.has(id)) throw makeError("RELEASE_REVIEW_REQUIRED", "A liberação desta solicitação exige revisão.");
    const previous = requestLocks.get(id) || Promise.resolve();
    const current = previous.then(() => withDatabaseLock(db, id, async (tx) => {
      const request = await tx.solicitacaoCertificado.findUnique({ where: { id }, include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
      if (!request) throw makeError("NOT_FOUND", "Solicitação não encontrada.");
      if (request.estado === "NEGADA") throw makeError("INVALID_TRANSITION", "A solicitação foi negada.");
      if (!request.certificado?.ativo) throw makeError("RELEASE_REVIEW_REQUIRED", "O certificado não está ativo.");
      if (request.estado === "APROVADA" && request.nomeArquivoLiberado && request.liberadoEm) {
        if (existingReleasedFile(request, destinationPath || getCertificadosLiberadosPath())) return request;
        throw makeError("RELEASE_REVIEW_REQUIRED", "A liberação registrada exige revisão.");
      }
      let createdTarget = null;
      try {
        const root = sourcePath || getCertificadosClientesPath();
        const source = resolveOrigin(root, request.certificado.origemChave);
        const destination = destinationPath || getCertificadosLiberadosPath();
        assertDirectory(destination, "RELEASE_DESTINATION_INVALID");
        const filename = request.nomeArquivoLiberado || releaseFilename(request, source.extension);
        const info = destinationInfo(filename, destination);
        if (io.existsSync(info.target)) throw makeError("RELEASE_DESTINATION_EXISTS", "Já existe um arquivo no destino da liberação.");
        createdTarget = info.target;
        io.copyFileSync(source.candidate, info.target, (io.constants || fs.constants).COPYFILE_EXCL);
        const data = { nomeArquivoLiberado: filename, liberadoEm: new Date(), erroLiberacao: null, tentativasLiberacao: { increment: 1 } };
        if (request.estado === "PENDENTE") Object.assign(data, { estado: "APROVADA", analisadoEm: new Date(), analisadoPor: String(actor || "ADMIN") });
        return await tx.solicitacaoCertificado.update({ where: { id }, data, include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
      } catch (error) {
        if (createdTarget) {
          try { io.unlinkSync(createdTarget); } catch { blocked.add(id); }
        }
        if (error.code === "RELEASE_DESTINATION_EXISTS") throw error;
        try { await tx.solicitacaoCertificado.update({ where: { id }, data: { erroLiberacao: "RELEASE_FAILED", tentativasLiberacao: { increment: 1 } } }); }
        catch { throw makeError("RELEASE_FAILED", "Não foi possível liberar o certificado. Nenhum detalhe interno foi exposto."); }
        return { __releaseFailure: true };
      }
    }));
    requestLocks.set(id, current.catch(() => {}));
    try {
      const result = await current;
      if (result?.__releaseFailure) throw makeError("RELEASE_FAILED", "Não foi possível liberar o certificado. Nenhum detalhe interno foi exposto.");
      return result;
    } finally { if (requestLocks.get(id) === current) requestLocks.delete(id); }
  }
  return { releaseRequest, publicRelease, _locks: requestLocks, _blocked: blocked, _resolveOrigin: resolveOrigin, _releaseFilename: releaseFilename };
}

module.exports = { createCertificateReleaseService, resolveOrigin, releaseFilename, publicRelease, safePart };
