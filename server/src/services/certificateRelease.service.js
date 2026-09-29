const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { buildOriginKey, MAX_DEPTH, SUPPORTED_EXTENSIONS, sanitizePublicBusinessName } = require("./certificados.service");
const { getCertificadosClientesPath, getCertificadosLiberadosPath, getCertificadosLiberadosUnc } = require("../config");
const { createCertificateRemovalHelper } = require("./certificateRemovalHelper.service");
const { createCertificateReleaseRetryAuthorizationService } = require("./certificateReleaseRetryAuthorization.service");

const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const RECOVERY_MAX_AGE_MS = 15 * 60 * 1000;
const REMOVAL_RECOVERY_STALE_MS = Number(process.env.CERTIFICATE_REMOVAL_RECOVERY_STALE_MS || 15 * 60 * 1000);
const REMOVAL_RECOVERY_BACKOFF_MS = Number(process.env.CERTIFICATE_REMOVAL_RECOVERY_BACKOFF_MS || 5 * 60 * 1000);
const REMOVAL_RECOVERY_MAX_RETRIES = Number(process.env.CERTIFICATE_REMOVAL_RECOVERY_MAX_RETRIES || 5);
const REMOVAL_RECOVERY_BATCH_LIMIT = Number(process.env.CERTIFICATE_REMOVAL_RECOVERY_BATCH_LIMIT || 3);
const REMOVAL_RECOVERY_MAX_OPERATION_MS = boundedEnv("CERTIFICATE_REMOVAL_RECOVERY_MAX_OPERATION_MS", 2 * 60 * 1000, 1000, 5 * 60 * 1000);
const REMOVAL_RECOVERY_LEASE_TTL_MS = boundedEnv("CERTIFICATE_REMOVAL_RECOVERY_LEASE_TTL_MS", 15 * 60 * 1000, Math.max(5 * 60 * 1000, REMOVAL_RECOVERY_MAX_OPERATION_MS * 2), 60 * 60 * 1000);
const REMOVAL_RECOVERY_STAGES = new Set(["REMOVAL_RECOVERY", "REMOVAL_RECOVERY_VALIDATE", "REMOVAL_RECOVERY_DELETE"]);
const RELEASE_EVENTS = new Set([
  "RELEASE_APPROVAL_STARTED", "RELEASE_PUBLISHED", "RELEASE_FAILED",
  "RELEASE_COMPENSATED", "RELEASE_RECOVERY_PENDING", "RELEASE_RECOVERED",
  "RELEASE_EXPIRED", "RELEASE_FILE_REMOVED", "RELEASE_REMOVAL_FAILED",
  "RELEASE_RETRY_AUTHORIZED", "RELEASE_RETRY_ACQUIRED", "RELEASE_RETRY_COMPLETED",
  "RELEASE_RETRY_FAILED", "RELEASE_RETRY_EXPIRED", "RELEASE_RETRY_CANCELLED"
]);

function makeError(code, message) { return Object.assign(new Error(message), { code }); }
function isReparsePoint(stats) { return Boolean(stats && (stats.isSymbolicLink?.() || stats.isReparsePoint?.())); }
function boundedEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
function removalRecoveryCode(error) {
  return `REMOVAL_RECOVERY_${String(error?.code || "FAILED").replace(/[^A-Z0-9_]/gi, "_").slice(0, 48)}`;
}
function removalRecoveryBackoffMs(retries) {
  return REMOVAL_RECOVERY_BACKOFF_MS * Math.min(2 ** Math.max(0, retries), 32);
}
function runExternalOperation(operation) {
  const startedAt = Date.now();
  const result = operation();
  if (Date.now() - startedAt > REMOVAL_RECOVERY_MAX_OPERATION_MS) throw makeError("REMOVAL_RECOVERY_TIMEOUT", "A operação externa excedeu o limite seguro.");
  return result;
}

function assertDirectory(directory, code, io = fs) {
  let stats;
  try { stats = io.lstatSync(directory); } catch { throw makeError(code, "Diretório de liberação indisponível."); }
  if (!stats.isDirectory() || isReparsePoint(stats)) throw makeError(code, "Diretório de liberação inválido.");
}

function realDirectory(directory, code, io = fs) {
  assertDirectory(directory, code, io);
  try { return io.realpathSync.native(directory); } catch { throw makeError(code, "Diretório de liberação indisponível."); }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveOrigin(root, originKey, io = fs) {
  if (!path.isAbsolute(String(root || ""))) throw makeError("RELEASE_SOURCE_INVALID", "A origem do certificado exige revisão.");
  const realRoot = realDirectory(root, "RELEASE_SOURCE_INVALID", io);
  const matches = [];
  function visit(directory, depth) {
    let entries;
    try { entries = io.readdirSync(directory, { withFileTypes: true }); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let stats;
      try { stats = io.lstatSync(candidate); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
      if (entry.isSymbolicLink?.() || isReparsePoint(stats)) throw makeError("RELEASE_SOURCE_REPARSE", "A origem do certificado exige revisão.");
      if (stats.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        visit(candidate, depth + 1);
        continue;
      }
      if (!stats.isFile() || !SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      let realCandidate;
      try { realCandidate = io.realpathSync.native(candidate); } catch { throw makeError("RELEASE_SOURCE_UNREADABLE", "Não foi possível localizar o certificado."); }
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
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(normalized);
  return (reserved ? `CERT-${normalized}` : normalized).slice(0, 64) || fallback;
}

function releaseFilename(request, extension) {
  const publicName = sanitizePublicBusinessName(request.certificado.nomeExibicao).name;
  const year = Number.isInteger(request.certificado.anoReferencia) ? request.certificado.anoReferencia : "CERT";
  const token = String(request.protocolo || crypto.randomUUID()).replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase();
  return `${safePart(publicName, "CERTIFICADO")}-${year}-SC-${request.id}-${token}${extension}`.slice(0, 180);
}

function destinationInfo(filename, configuredDestination = null, io = fs) {
  const destination = configuredDestination || getCertificadosLiberadosPath();
  const realDestination = realDirectory(destination, "RELEASE_DESTINATION_INVALID", io);
  if (path.basename(filename) !== filename || !/^.+\.(?:pfx|p12)$/i.test(filename)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
  const target = path.resolve(destination, filename);
  if (!isWithin(path.resolve(destination), target)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
  return { destination, realDestination, target };
}

function hashFile(filename, io) { return crypto.createHash("sha256").update(io.readFileSync(filename)).digest("hex"); }
function attemptTempFilename(attemptId, extension) { return `.${attemptId}${extension}.tmp`; }

function tempInfo(attemptId, extension, destination, io) {
  const realDestination = realDirectory(destination, "RELEASE_DESTINATION_INVALID", io);
  const filename = attemptTempFilename(attemptId, extension);
  const target = path.resolve(destination, filename);
  if (path.basename(target) !== filename || !isWithin(path.resolve(destination), target)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
  return { destination, realDestination, target };
}

function ownedTempDelete(temp, destination, attemptId, extension, io) {
  const info = tempInfo(attemptId, extension, destination, io);
  if (path.resolve(info.target) !== path.resolve(temp)) throw makeError("RELEASE_OWNERSHIP_INVALID", "O arquivo temporário exige revisão.");
  let stats;
  try { stats = io.lstatSync(temp); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (!stats.isFile() || isReparsePoint(stats)) throw makeError("RELEASE_OWNERSHIP_INVALID", "O arquivo temporário exige revisão.");
  const realTemp = io.realpathSync.native(temp);
  if (!isWithin(info.realDestination, realTemp)) throw makeError("RELEASE_OWNERSHIP_INVALID", "O arquivo temporário exige revisão.");
  io.unlinkSync(temp);
  return true;
}

function publishAtomically(source, info, attemptId, expectedFingerprint = null, expectedSize = null, io = fs) {
  if (io.existsSync(info.target)) throw makeError("RELEASE_DESTINATION_EXISTS", "Já existe um arquivo no destino da liberação.");
  const temp = path.join(info.destination, attemptTempFilename(attemptId, source.extension));
  let tempCreated = false;
  let published = false;
  try {
    tempCreated = true;
    io.copyFileSync(source.candidate, temp, (io.constants || fs.constants).COPYFILE_EXCL);
    const sourceStats = io.lstatSync(source.candidate);
    const tempStats = io.lstatSync(temp);
    if (!sourceStats.isFile() || isReparsePoint(sourceStats) || !tempStats.isFile() || isReparsePoint(tempStats) || tempStats.size !== sourceStats.size || (expectedSize !== null && tempStats.size !== expectedSize)) throw makeError("RELEASE_COPY_VERIFY_FAILED", "A cópia do certificado não passou na validação.");
    const handle = io.openSync(temp, "r+");
    try { io.fsyncSync(handle); } finally { io.closeSync(handle); }
    const fingerprint = hashFile(source.candidate, io);
    if (fingerprint !== hashFile(temp, io) || (expectedFingerprint && fingerprint !== expectedFingerprint)) throw makeError("RELEASE_COPY_VERIFY_FAILED", "A cópia do certificado não passou na validação.");
    const realTemp = io.realpathSync.native(temp);
    if (!isWithin(info.realDestination, realTemp)) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
    if (io.existsSync(info.target)) throw makeError("RELEASE_DESTINATION_EXISTS", "Já existe um arquivo no destino da liberação.");
    if (typeof io.linkSync !== "function") throw makeError("RELEASE_ATOMIC_UNSUPPORTED", "O destino não suporta publicação atômica segura.");
    io.linkSync(temp, info.target);
    published = true;
    const finalStats = io.lstatSync(info.target);
    if (!finalStats.isFile() || isReparsePoint(finalStats) || finalStats.size !== sourceStats.size || hashFile(info.target, io) !== fingerprint) throw makeError("RELEASE_PUBLISH_VERIFY_FAILED", "A publicação do certificado não passou na validação.");
    io.unlinkSync(temp);
    tempCreated = false;
    return { temp, target: info.target, fingerprint, size: sourceStats.size };
  } catch (error) {
    if (tempCreated) { try { io.unlinkSync(temp); } catch (_) {} }
    if (published) { try { io.unlinkSync(info.target); } catch (_) {} }
    throw error;
  }
}

function releaseStatus(request, currentTime = Date.now()) {
  if (request.statusLiberacao === "LEGADO") return "LEGADO";
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= currentTime) return "EXPIRADA";
  return request.statusLiberacao || (request.nomeArquivoLiberado ? "LEGADO" : "NAO_LIBERADO");
}

function publicRelease(request, io = fs, configuredDestination = null, currentTime = Date.now()) {
  if (!request?.nomeArquivoLiberado || (request.releasedAt && request.expiresAt && new Date(request.expiresAt).getTime() <= currentTime)) return null;
  if (request.releasedAt && !request.expiresAt) return null;
  try {
    const info = destinationInfo(request.nomeArquivoLiberado, configuredDestination, io);
    const stats = io.lstatSync(info.target);
    if (!stats.isFile() || isReparsePoint(stats)) return null;
    const realTarget = io.realpathSync.native(info.target);
    if (!isWithin(info.realDestination, realTarget)) return null;
    return { nomeArquivoLiberado: request.nomeArquivoLiberado, liberadoEm: request.liberadoEm, releasedAt: request.releasedAt, expiresAt: request.expiresAt, compartilhamento: getCertificadosLiberadosUnc() };
  } catch { return null; }
}

function auditData(request, event, result, code, actor = null, occurredAt = new Date(), retryAuthorizationId = null) {
  return { evento: event, solicitacaoId: request.id, certificadoId: request.certificadoId || request.certificado?.id, retryAuthorizationId, administrador: actor || request.analisadoPor || null, hostnameSolicitante: request.hostnameRegistrado || request.computador?.hostname || null, usuarioSolicitante: request.usuarioWindowsRegistrado || request.computador?.usuario || null, ocorridoEm: occurredAt, resultado: result, codigo: String(code || "UNKNOWN").replace(/[^A-Z0-9_]/gi, "_").slice(0, 64) };
}

function failureCode(stage, error) {
  const code = String(error?.code || "FAILED").replace(/[^A-Z0-9_]/gi, "_").slice(0, 48);
  return `${String(stage || "UNKNOWN").replace(/[^A-Z0-9_]/gi, "_").slice(0, 16)}_${code}`;
}

function createCertificateReleaseService({ db, fsModule = fs, sourcePath = null, destinationPath = null, now = () => new Date(), log = () => {}, removalHelper = null } = {}) {
  if (!db) throw new Error("Banco de dados obrigatório.");
  const io = fsModule;
  const requestLocks = new Map();
  let cleanupInProgress = false;
  let removalRecoveryInProgress = false;
  const isolatedRemovalHelper = removalHelper || createCertificateRemovalHelper({ log });

  async function audit(request, event, result, code, actor = null, auditDb = db, retryAuthorizationId = null) {
    if (!RELEASE_EVENTS.has(event) || !auditDb.certificadoLiberacaoAuditoria?.create) return;
    await auditDb.certificadoLiberacaoAuditoria.create({ data: auditData(request, event, result, code, actor, now(), retryAuthorizationId) });
  }

  const retryAuthorization = createCertificateReleaseRetryAuthorizationService({ db, now, maxRetries: REMOVAL_RECOVERY_MAX_RETRIES, audit });

  async function reserve(requestId, actor) {
    return shortTransaction(db, async (tx) => {
      const request = await tx.solicitacaoCertificado.findUnique({ where: { id: requestId }, include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
      if (!request) throw makeError("NOT_FOUND", "Solicitação não encontrada.");
      if (request.estado === "APROVADA" && request.statusLiberacao === "LIBERADO" && request.releasedAt && request.expiresAt && new Date(request.expiresAt).getTime() > now().getTime()) return { ...request, __alreadyReleased: true };
      if (request.estado !== "PENDENTE" || !["NAO_LIBERADO", "FALHA_RECUPERAVEL", undefined, null].includes(request.statusLiberacao)) throw makeError("INVALID_TRANSITION", "A solicitação não está pendente.");
      if (!request.certificado?.ativo) throw makeError("RELEASE_REVIEW_REQUIRED", "O certificado não está ativo.");
      const attemptId = crypto.randomUUID();
      const filename = releaseFilename(request, request.certificado.extensao);
      const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: requestId, estado: "PENDENTE", statusLiberacao: { in: ["NAO_LIBERADO", "FALHA_RECUPERAVEL"] } }, data: { statusLiberacao: "PUBLICANDO", releaseAttemptId: attemptId, releaseStartedAt: now(), releaseStage: "RESOLVING_SOURCE", nomeArquivoLiberado: filename, releaseFingerprint: null, erroLiberacao: null } });
      if (changed.count !== 1) throw makeError("RELEASE_CONFLICT", "A solicitação já está sendo processada ou exige nova revisão.");
      const reserved = { ...request, statusLiberacao: "PUBLICANDO", releaseAttemptId: attemptId, nomeArquivoLiberado: filename, releaseStage: "RESOLVING_SOURCE" };
      await audit(reserved, "RELEASE_APPROVAL_STARTED", "SUCCESS", "RESERVED", actor, tx);
      return reserved;
    });
  }

  async function updateStage(request, stage, extra = {}) {
    const result = await shortTransaction(db, (tx) => tx.solicitacaoCertificado.updateMany({ where: { id: request.id, statusLiberacao: "PUBLICANDO", releaseAttemptId: request.releaseAttemptId }, data: { releaseStage: stage, ...extra } }));
    if (result.count !== 1) throw makeError("RELEASE_CONFLICT", "A tentativa de liberação não está mais ativa.");
  }

  async function finalize(request, published, actor) {
    return shortTransaction(db, async (tx) => {
      const releasedAt = now();
      const expiresAt = new Date(releasedAt.getTime() + RELEASE_TTL_MS);
      const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: request.id, estado: "PENDENTE", statusLiberacao: "PUBLICANDO", releaseAttemptId: request.releaseAttemptId }, data: { estado: "APROVADA", statusLiberacao: "LIBERADO", releasedAt, expiresAt, liberadoEm: releasedAt, releaseFingerprint: published.fingerprint, releaseStage: null, releaseAttemptId: null, releaseStartedAt: null, erroLiberacao: null, analisadoEm: releasedAt, analisadoPor: String(actor || "ADMIN"), tentativasLiberacao: { increment: 1 } } });
      if (changed.count !== 1) throw makeError("RELEASE_FINALIZATION_CONFLICT", "A tentativa de liberação exige recuperação.");
      const result = await tx.solicitacaoCertificado.findUnique({ where: { id: request.id }, include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
      await audit(result, "RELEASE_PUBLISHED", "SUCCESS", "PUBLISHED", actor, tx);
      return result;
    });
  }

  async function ownedDelete(filename, destination, fingerprint, io = fs) {
    if (!filename) return { removed: false, safe: false };
    const info = destinationInfo(filename, destination, io);
    let stats;
    try { stats = io.lstatSync(info.target); } catch (error) { if (error.code === "ENOENT") return { removed: false, safe: true }; throw error; }
    if (!stats.isFile() || isReparsePoint(stats)) throw makeError("RELEASE_OWNERSHIP_INVALID", "O arquivo de recuperação exige revisão.");
    const realTarget = io.realpathSync.native(info.target);
    if (!isWithin(info.realDestination, realTarget) || !fingerprint || hashFile(info.target, io) !== fingerprint) throw makeError("RELEASE_OWNERSHIP_INVALID", "O arquivo de recuperação exige revisão.");
    io.unlinkSync(info.target);
    return { removed: true, safe: true };
  }

  async function compensate(request, artifacts, actor, failureCode) {
    const target = artifacts?.target || null;
    try {
      if (artifacts?.temp) { const extension = artifacts.extension || path.extname(request.nomeArquivoLiberado || ".pfx").toLowerCase(); try { ownedTempDelete(artifacts.temp, destinationPath || null, request.releaseAttemptId, extension, io); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (target && artifacts.published) await ownedDelete(path.basename(target), destinationPath || null, artifacts.fingerprint, io);
      const reset = await shortTransaction(db, async (tx) => {
        const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: request.id, statusLiberacao: "PUBLICANDO", releaseAttemptId: request.releaseAttemptId }, data: { estado: "PENDENTE", statusLiberacao: "NAO_LIBERADO", nomeArquivoLiberado: null, releasedAt: null, expiresAt: null, liberadoEm: null, releaseAttemptId: null, releaseStartedAt: null, releaseStage: null, releaseFingerprint: null, erroLiberacao: "RELEASE_FAILED", tentativasLiberacao: { increment: 1 } } });
        return changed.count === 1;
      });
      if (!reset) throw makeError("RELEASE_CONFLICT", "A tentativa de liberação exige recuperação.");
      await audit(request, "RELEASE_FAILED", "FAILURE", failureCode, actor);
      await audit(request, "RELEASE_COMPENSATED", "SUCCESS", "COMPENSATED", actor);
      return true;
    } catch (error) {
      await shortTransaction(db, (tx) => tx.solicitacaoCertificado.updateMany({ where: { id: request.id, statusLiberacao: "PUBLICANDO", releaseAttemptId: request.releaseAttemptId }, data: { statusLiberacao: "RECUPERACAO_PENDENTE", erroLiberacao: "RELEASE_RECOVERY_PENDING" } })).catch(() => {});
      await audit(request, "RELEASE_FAILED", "FAILURE", failureCode, actor).catch(() => {});
      await audit(request, "RELEASE_RECOVERY_PENDING", "FAILURE", error.code || "RECOVERY_PENDING", actor).catch(() => {});
      log("[Monitor TI] release_recovery status=RECUPERACAO_PENDENTE");
      return false;
    }
  }

  async function releaseRequest(requestId, actor) {
    const id = Number(requestId);
    if (!Number.isInteger(id) || id <= 0) throw makeError("INVALID_ID", "Solicitação inválida.");
    const previous = requestLocks.get(id) || Promise.resolve();
    const current = previous.then(async () => {
      const reserved = await reserve(id, actor);
      if (reserved.__alreadyReleased) return reserved;
      let artifacts = null;
      let stage = "RESOLVING_SOURCE";
      try {
        stage = "SOURCE_RESOLUTION";
        const source = resolveOrigin(sourcePath || getCertificadosClientesPath(), reserved.certificado.origemChave, io);
        stage = "SOURCE_FINGERPRINT";
        const fingerprint = hashFile(source.candidate, io);
        const stats = io.lstatSync(source.candidate);
        stage = "DESTINATION_VALIDATION";
        await updateStage(reserved, "VALIDATING_DESTINATION", { releaseFingerprint: fingerprint });
        const info = destinationInfo(reserved.nomeArquivoLiberado, destinationPath || getCertificadosLiberadosPath(), io);
        stage = "PUBLISHING";
        await updateStage(reserved, "PUBLISHING");
        artifacts = { temp: path.join(info.destination, attemptTempFilename(reserved.releaseAttemptId, source.extension)), target: info.target, extension: source.extension, published: false };
        const published = publishAtomically(source, info, reserved.releaseAttemptId, fingerprint, stats.size, io);
        artifacts = { ...artifacts, ...published, published: true };
        stage = "FINALIZING";
        return await finalize(reserved, published, actor);
      } catch (error) {
        await compensate(reserved, artifacts, actor, failureCode(stage, error)).catch(() => {});
        if (error.code === "RELEASE_DESTINATION_EXISTS") throw error;
        throw makeError("RELEASE_FAILED", "Não foi possível liberar o certificado. Nenhum detalhe interno foi exposto.");
      }
    });
    requestLocks.set(id, current.catch(() => {}));
    try { return await current; } finally { if (requestLocks.get(id) === current) requestLocks.delete(id); }
  }

  async function recoverAttempt(request) {
    const extension = path.extname(request.nomeArquivoLiberado || request.certificado?.extensao || ".pfx").toLowerCase();
    const destination = destinationPath || String(process.env.CERTIFICADOS_LIBERADOS_PATH || "").trim();
    try {
      if (!path.isAbsolute(destination) || destination.length > 4096) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
      const tempResult = await isolatedRemovalHelper.run({ operation: "remove_temp", destinationRoot: destination, filename: attemptTempFilename(request.releaseAttemptId, extension), expectedFingerprint: "" });
      if (!tempResult.ok && tempResult.code !== "HELPER_TARGET_UNAVAILABLE") throw makeError(tempResult.code || "RELEASE_RECOVERY_PENDING", "A recuperação do temporário falhou.");
      const finalResult = request.releaseFingerprint
        ? await isolatedRemovalHelper.run({ operation: "remove", destinationRoot: destination, filename: request.nomeArquivoLiberado, expectedFingerprint: request.releaseFingerprint })
        : await isolatedRemovalHelper.run({ operation: "inspect_presence", destinationRoot: destination, filename: request.nomeArquivoLiberado, expectedFingerprint: "" });
      if (!finalResult.ok || (request.releaseFingerprint && !["ABSENT", "REMOVED"].includes(finalResult.result)) || (!request.releaseFingerprint && finalResult.result === "PRESENT")) throw makeError(finalResult.code || "RELEASE_OWNERSHIP_INVALID", "A tentativa exige revisão de propriedade.");
      await shortTransaction(db, async (tx) => {
        const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: request.id, statusLiberacao: { in: ["PUBLICANDO", "RECUPERACAO_PENDENTE"] }, releaseAttemptId: request.releaseAttemptId }, data: { estado: "PENDENTE", statusLiberacao: "NAO_LIBERADO", nomeArquivoLiberado: null, releaseAttemptId: null, releaseStartedAt: null, releaseStage: null, releaseFingerprint: null, erroLiberacao: "RELEASE_RECOVERED" } });
        if (changed.count !== 1) throw makeError("RELEASE_CONFLICT", "A tentativa exige revisão.");
        await audit(request, "RELEASE_RECOVERED", "SUCCESS", "RECOVERED", null, tx);
      });
      return true;
    } catch (error) {
      await shortTransaction(db, (tx) => tx.solicitacaoCertificado.updateMany({ where: { id: request.id, releaseAttemptId: request.releaseAttemptId }, data: { statusLiberacao: "RECUPERACAO_PENDENTE", erroLiberacao: "RELEASE_RECOVERY_PENDING" } })).catch(() => {});
      await audit(request, "RELEASE_RECOVERY_PENDING", "FAILURE", error.code || "RECOVERY_PENDING").catch(() => {});
      return false;
    }
  }

  async function recoverAbandonedAttempts() {
    const cutoff = new Date(now().getTime() - RECOVERY_MAX_AGE_MS);
    const rows = await db.solicitacaoCertificado.findMany({ where: { releaseAttemptId: { not: null }, releaseStartedAt: { lt: cutoff }, statusLiberacao: { in: ["PUBLICANDO", "RECUPERACAO_PENDENTE"] } }, include: { certificado: true } });
    let recovered = 0;
    for (const row of rows) if (await recoverAttempt(row)) recovered += 1;
    return { found: rows.length, recovered };
  }

  async function cleanupExpired() {
    if (cleanupInProgress) return { skipped: true };
    cleanupInProgress = true;
    let removed = 0;
    try {
      const rows = await db.solicitacaoCertificado.findMany({ where: { releasedAt: { not: null }, expiresAt: { lte: now() }, statusLiberacao: "LIBERADO" }, include: { certificado: true, computador: { select: { hostname: true, usuario: true } } } });
      for (const request of rows) {
        try {
          const destination = destinationPath || String(process.env.CERTIFICADOS_LIBERADOS_PATH || "").trim();
          if (!path.isAbsolute(destination) || destination.length > 4096) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
          const inspected = await isolatedRemovalHelper.run({ operation: "inspect", destinationRoot: destination, filename: request.nomeArquivoLiberado, expectedFingerprint: request.releaseFingerprint });
          if (!inspected.ok || !["ABSENT", "PRESENT_VALID"].includes(inspected.result)) throw makeError(inspected.code || "RELEASE_REMOVAL_HELPER_FAILED", "A inspeção da remoção falhou.");
          let result = inspected.result;
          if (result === "PRESENT_VALID") {
            const removedResult = await isolatedRemovalHelper.run({ operation: "remove", destinationRoot: destination, filename: request.nomeArquivoLiberado, expectedFingerprint: request.releaseFingerprint });
            if (!removedResult.ok || !["REMOVED", "ABSENT"].includes(removedResult.result)) throw makeError(removedResult.code || "RELEASE_REMOVAL_HELPER_FAILED", "A remoção falhou.");
            result = removedResult.result;
            if (result === "REMOVED") removed += 1;
          }
          await shortTransaction(db, async (tx) => {
            await tx.solicitacaoCertificado.update({ where: { id: request.id }, data: { statusLiberacao: "EXPIRADA" } });
            await audit(request, "RELEASE_EXPIRED", "SUCCESS", "EXPIRED", null, tx);
            await audit(request, "RELEASE_FILE_REMOVED", "SUCCESS", result === "REMOVED" ? "REMOVED" : "ALREADY_ABSENT", null, tx);
          });
        } catch (error) {
          await db.solicitacaoCertificado.update({ where: { id: request.id }, data: { statusLiberacao: "REMOCAO_PENDENTE", erroLiberacao: "RELEASE_REMOVAL_FAILED" } }).catch(() => {});
          await audit(request, "RELEASE_REMOVAL_FAILED", "FAILURE", error.code || "REMOVAL_FAILED").catch(() => {});
          log("[Monitor TI] release_cleanup status=REMOCAO_PENDENTE");
        }
      }
      return { expired: rows.length, removed };
    } finally { cleanupInProgress = false; }
  }

  async function recoverStaleRemovals() {
    if (removalRecoveryInProgress) return { skipped: true };
    removalRecoveryInProgress = true;
    try {
      const current = now();
      const cutoff = new Date(current.getTime() - REMOVAL_RECOVERY_STALE_MS);
      const leaseCutoff = new Date(current.getTime() - REMOVAL_RECOVERY_LEASE_TTL_MS);
      const candidates = await db.solicitacaoCertificado.findMany({
        where: {
          estado: "APROVADA",
          statusLiberacao: "REMOCAO_PENDENTE",
          expiresAt: { lte: current },
          OR: [
            { atualizadoEm: { lt: cutoff }, tentativasLiberacao: { lt: REMOVAL_RECOVERY_MAX_RETRIES } },
            { tentativasLiberacao: { gte: REMOVAL_RECOVERY_MAX_RETRIES }, retryAuthorizations: { some: { status: "PENDING", expiresAt: { gt: current } } } },
            { tentativasLiberacao: { gte: REMOVAL_RECOVERY_MAX_RETRIES }, retryAuthorizations: { some: { status: "ACQUIRED" } } }
          ],
          AND: [{ OR: [
            { releaseAttemptId: null, releaseStartedAt: null, releaseStage: null },
            { releaseAttemptId: { not: null }, releaseStartedAt: { not: null, lt: leaseCutoff }, releaseStage: { in: [...REMOVAL_RECOVERY_STAGES] } }
          ] }]
        },
        include: { certificado: true, retryAuthorizations: { where: { status: { in: ["PENDING", "ACQUIRED"] } }, orderBy: { createdAt: "asc" }, take: 2 } },
        orderBy: [{ atualizadoEm: "asc" }, { id: "asc" }],
        take: REMOVAL_RECOVERY_BATCH_LIMIT
      });
      let recovered = 0;
      let failed = 0;
      let extraordinary = 0;
      let extraordinaryCandidates = 0;
      let backoffSkipped = 0;
      for (const candidate of candidates) {
        const authorization = Number(candidate.tentativasLiberacao) >= REMOVAL_RECOVERY_MAX_RETRIES
          ? candidate.retryAuthorizations?.find((item) => item.status === "PENDING" && new Date(item.expiresAt).getTime() > current.getTime()) || candidate.retryAuthorizations?.find((item) => item.status === "ACQUIRED" && item.attemptId === candidate.releaseAttemptId)
          : null;
        const authorizationAlreadyAcquired = authorization?.status === "ACQUIRED";
        if (authorization) extraordinaryCandidates += 1;
        if (!authorization && current.getTime() - new Date(candidate.atualizadoEm).getTime() < removalRecoveryBackoffMs(candidate.tentativasLiberacao)) { backoffSkipped += 1; continue; }
        const lease = authorizationAlreadyAcquired ? candidate.releaseAttemptId : crypto.randomUUID();
        const staleLease = candidate.releaseAttemptId !== null;
        const leaseWhere = {
          id: candidate.id,
          estado: "APROVADA",
          statusLiberacao: "REMOCAO_PENDENTE",
          expiresAt: { lte: current },
          tentativasLiberacao: authorization ? { gte: REMOVAL_RECOVERY_MAX_RETRIES } : { lt: REMOVAL_RECOVERY_MAX_RETRIES },
          ...(staleLease ? {
            releaseAttemptId: candidate.releaseAttemptId,
            releaseStartedAt: { lt: leaseCutoff, equals: candidate.releaseStartedAt },
            releaseStage: candidate.releaseStage
          } : {
            releaseAttemptId: null,
            releaseStartedAt: null,
            releaseStage: null
          })
        };
        const leased = await shortTransaction(db, async (tx) => {
          const changed = await tx.solicitacaoCertificado.updateMany({ where: leaseWhere, data: { releaseAttemptId: lease, releaseStartedAt: current, releaseStage: "REMOVAL_RECOVERY_VALIDATE" } });
          if (changed.count !== 1 || !authorization || authorizationAlreadyAcquired) return changed;
          const consumed = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: authorization.id, solicitacaoId: candidate.id, status: "PENDING", expiresAt: { gt: current } }, data: { status: "ACQUIRED", acquiredAt: current, attemptId: lease } });
          if (consumed.count !== 1) throw makeError("RETRY_AUTHORIZATION_CAS_LOST", "A autorização extraordinária não está mais disponível.");
          await audit(candidate, "RELEASE_RETRY_ACQUIRED", "SUCCESS", "ACQUIRED", null, tx, authorization.id);
          extraordinary += 1;
          return changed;
        });
        if (leased.count !== 1) continue;
        const activeLease = { attemptId: lease, startedAt: current, stage: "REMOVAL_RECOVERY_VALIDATE", authorizationId: authorization?.id || null };
        try {
          const destination = destinationPath || String(process.env.CERTIFICADOS_LIBERADOS_PATH || "").trim();
          if (!path.isAbsolute(destination) || destination.length > 4096) throw makeError("RELEASE_DESTINATION_INVALID", "O destino da liberação exige revisão.");
          const inspected = await isolatedRemovalHelper.run({ operation: "inspect", destinationRoot: destination, filename: candidate.nomeArquivoLiberado, expectedFingerprint: candidate.releaseFingerprint });
          if (!inspected.ok || !["ABSENT", "PRESENT_VALID"].includes(inspected.result)) throw makeError(inspected.code || "RELEASE_REMOVAL_HELPER_FAILED", "A inspeção da remoção falhou.");
          const absent = inspected.result === "ABSENT";
          const renewedAt = now();
          const renewed = await shortTransaction(db, (tx) => tx.solicitacaoCertificado.updateMany({
            where: {
              id: candidate.id,
              estado: "APROVADA",
              statusLiberacao: "REMOCAO_PENDENTE",
              expiresAt: { lte: current },
              releaseAttemptId: activeLease.attemptId,
              releaseStartedAt: activeLease.startedAt,
              releaseStage: { in: [...REMOVAL_RECOVERY_STAGES] },
              tentativasLiberacao: authorization ? { gte: REMOVAL_RECOVERY_MAX_RETRIES } : { lt: REMOVAL_RECOVERY_MAX_RETRIES }
            },
            data: { releaseStartedAt: renewedAt, releaseStage: absent ? "REMOVAL_RECOVERY_VALIDATE" : "REMOVAL_RECOVERY_DELETE" }
          }));
          if (renewed.count !== 1) throw makeError("RELEASE_RECOVERY_LEASE_LOST", "A recuperação perdeu o lease.");
          activeLease.startedAt = renewedAt;
          activeLease.stage = absent ? "REMOVAL_RECOVERY_VALIDATE" : "REMOVAL_RECOVERY_DELETE";
          if (absent) {
            await shortTransaction(db, async (tx) => {
              const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: candidate.id, estado: "APROVADA", statusLiberacao: "REMOCAO_PENDENTE", releaseAttemptId: activeLease.attemptId, releaseStartedAt: activeLease.startedAt, releaseStage: activeLease.stage }, data: { statusLiberacao: "EXPIRADA", releaseAttemptId: null, releaseStartedAt: null, releaseStage: null } });
              if (changed.count !== 1) throw makeError("RELEASE_RECOVERY_CONFLICT", "A recuperação mudou de proprietário.");
              if (activeLease.authorizationId) {
                const completed = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: activeLease.authorizationId, status: "ACQUIRED", attemptId: activeLease.attemptId }, data: { status: "COMPLETED", completedAt: now() } });
                if (completed.count !== 1) throw makeError("RETRY_AUTHORIZATION_CONFLICT", "A autorização extraordinária perdeu a aquisição.");
              }
              await audit(candidate, "RELEASE_EXPIRED", "SUCCESS", "EXPIRED", null, tx, activeLease.authorizationId);
              await audit(candidate, "RELEASE_FILE_REMOVED", "SUCCESS", "ALREADY_ABSENT", null, tx, activeLease.authorizationId);
              if (activeLease.authorizationId) await audit(candidate, "RELEASE_RETRY_COMPLETED", "SUCCESS", "ALREADY_ABSENT", null, tx, activeLease.authorizationId);
            });
            recovered += 1;
            continue;
          }
          const removed = await isolatedRemovalHelper.run({ operation: "remove", destinationRoot: destination, filename: candidate.nomeArquivoLiberado, expectedFingerprint: candidate.releaseFingerprint });
          if (!removed.ok || !["REMOVED", "ABSENT"].includes(removed.result)) throw makeError(removed.code || "RELEASE_REMOVAL_HELPER_FAILED", "A remoção falhou ou ficou inconclusiva.");
          await shortTransaction(db, async (tx) => {
            const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: candidate.id, estado: "APROVADA", statusLiberacao: "REMOCAO_PENDENTE", releaseAttemptId: activeLease.attemptId, releaseStartedAt: activeLease.startedAt, releaseStage: activeLease.stage }, data: { statusLiberacao: "EXPIRADA", releaseAttemptId: null, releaseStartedAt: null, releaseStage: null } });
            if (changed.count !== 1) throw makeError("RELEASE_RECOVERY_CONFLICT", "A recuperação mudou de proprietário.");
            if (activeLease.authorizationId) {
              const completed = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: activeLease.authorizationId, status: "ACQUIRED", attemptId: activeLease.attemptId }, data: { status: "COMPLETED", completedAt: now() } });
              if (completed.count !== 1) throw makeError("RETRY_AUTHORIZATION_CONFLICT", "A autorização extraordinária perdeu a aquisição.");
            }
            const resultCode = removed.result === "ABSENT" ? "ALREADY_ABSENT" : "REMOVED";
            await audit(candidate, "RELEASE_EXPIRED", "SUCCESS", "EXPIRED", null, tx, activeLease.authorizationId);
            await audit(candidate, "RELEASE_FILE_REMOVED", "SUCCESS", resultCode, null, tx, activeLease.authorizationId);
            if (activeLease.authorizationId) await audit(candidate, "RELEASE_RETRY_COMPLETED", "SUCCESS", resultCode, null, tx, activeLease.authorizationId);
          });
          recovered += 1;
        } catch (error) {
          failed += 1;
          await shortTransaction(db, async (tx) => {
            const changed = await tx.solicitacaoCertificado.updateMany({ where: { id: candidate.id, estado: "APROVADA", statusLiberacao: "REMOCAO_PENDENTE", releaseAttemptId: activeLease.attemptId, releaseStartedAt: activeLease.startedAt, releaseStage: { in: [...REMOVAL_RECOVERY_STAGES] } }, data: { releaseAttemptId: null, releaseStartedAt: null, releaseStage: null, erroLiberacao: removalRecoveryCode(error), ...(activeLease.authorizationId ? {} : { tentativasLiberacao: { increment: 1 } }) } });
            if (changed.count === 1) {
              if (activeLease.authorizationId) {
                const failedAuthorization = await tx.certificateReleaseRetryAuthorization.updateMany({ where: { id: activeLease.authorizationId, status: "ACQUIRED", attemptId: activeLease.attemptId }, data: { status: "FAILED", failedAt: now(), errorCode: removalRecoveryCode(error) } });
                if (failedAuthorization.count !== 1) throw makeError("RETRY_AUTHORIZATION_CONFLICT", "A autorização extraordinária perdeu a aquisição.");
                await audit(candidate, "RELEASE_RETRY_FAILED", "FAILURE", removalRecoveryCode(error), null, tx, activeLease.authorizationId);
              } else await audit(candidate, "RELEASE_REMOVAL_FAILED", "FAILURE", removalRecoveryCode(error), null, tx);
            }
          }).catch(() => {});
        }
      }
      return { found: candidates.length, normalCandidates: candidates.length - extraordinaryCandidates, extraordinaryCandidates, recovered, failed, extraordinary, backoffSkipped };
    } finally { removalRecoveryInProgress = false; }
  }

  return { releaseRequest, cleanupExpired, recoverAbandonedAttempts, recoverStaleRemovals, expireRetryAuthorizations: retryAuthorization.expire, authorizeExtraordinaryRetry: retryAuthorization.create, cancelExtraordinaryRetry: retryAuthorization.cancel, stopRecovery: isolatedRemovalHelper.stop, publicRelease: (request) => publicRelease(request, io, destinationPath || null, now().getTime()), releaseStatus, _locks: requestLocks, _resolveOrigin: (root, key) => resolveOrigin(root, key, io), _releaseFilename: releaseFilename, _publishAtomically: (source, info, attemptId, fingerprint, size) => publishAtomically(source, info, attemptId, fingerprint, size, io), _ownedDelete: (filename, destination, fingerprint) => ownedDelete(filename, destination, fingerprint, io) };
}

async function shortTransaction(db, operation) {
  if (typeof db.$transaction !== "function") return operation(db);
  return db.$transaction(operation);
}

module.exports = { RELEASE_TTL_MS, CLEANUP_INTERVAL_MS, RECOVERY_MAX_AGE_MS, REMOVAL_RECOVERY_STALE_MS, REMOVAL_RECOVERY_BACKOFF_MS, REMOVAL_RECOVERY_MAX_RETRIES, REMOVAL_RECOVERY_BATCH_LIMIT, REMOVAL_RECOVERY_MAX_OPERATION_MS, REMOVAL_RECOVERY_LEASE_TTL_MS, REMOVAL_RECOVERY_STAGES, RELEASE_EVENTS, createCertificateReleaseService, resolveOrigin, releaseFilename, publicRelease, safePart, destinationInfo, releaseStatus, isReparsePoint, removalRecoveryBackoffMs, removalRecoveryCode };
