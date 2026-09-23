const crypto = require("crypto");
const net = require("net");
const prisma = require("../prisma");
const certificatesService = require("./certificados.service");
const { createCertificateReleaseService } = require("./certificateRelease.service");
const { getPortalCookieSecure } = require("../config");

const PORTAL_COOKIE = "ht_portal_session";
const SESSION_TTL_MS = 15 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const PORTAL_STATES = ["PENDENTE", "APROVADA", "NEGADA"];
const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function normalizeIp(value) {
  let ip = String(value || "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (net.isIP(ip) === 0) return null;
  return ip === "::1" ? "127.0.0.1" : ip;
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

function makeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function publishBrowserNotification(browserNotifications, method, ...args) {
  try { browserNotifications?.[method]?.(...args); } catch { /* notificações não podem desfazer a operação principal */ }
}

function createPortalService({ db = prisma, now = () => Date.now(), randomBytes = (size) => crypto.randomBytes(size), cookieSecure = getPortalCookieSecure(), releaseService = null, browserNotifications = null } = {}) {
  const sessions = new Map();
  const certificateRelease = releaseService || createCertificateReleaseService({ db });

  function cleanup() {
    const timestamp = now();
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id);
  }

  async function resolveComputer(ip) {
    const normalized = normalizeIp(ip);
    if (!normalized) throw makeError("PORTAL_IP_INVALID", "O endere├ºo IP desta esta├º├úo ├® inv├ílido.");
    if (isLoopback(normalized)) throw makeError("PORTAL_LOOPBACK_BLOCKED", "O portal n├úo pode associar uma esta├º├úo por loopback.");
    const computers = await db.computador.findMany({
      where: { status: "online" },
      select: { id: true, ip: true, hostname: true, usuario: true }
    });
    const matches = computers.filter((computer) => normalizeIp(computer.ip) === normalized);
    if (matches.length === 0) throw makeError("PORTAL_COMPUTER_NOT_FOUND", "Nenhuma esta├º├úo online foi identificada para este acesso.");
    if (matches.length > 1) throw makeError("PORTAL_COMPUTER_AMBIGUOUS", "Mais de uma esta├º├úo online corresponde a este acesso.");
    return { ...matches[0], ip: normalized };
  }

  async function createSession(ip) {
    const computer = await resolveComputer(ip);
    cleanup();
    const id = randomBytes(32).toString("hex");
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(id, { computerId: computer.id, ip: computer.ip, createdAt: now(), expiresAt });
    return { id, computer, expiresAt };
  }

  async function getSession(id, ip) {
    cleanup();
    const session = sessions.get(String(id || ""));
    if (!session || session.expiresAt <= now()) return null;
    if (normalizeIp(ip) !== session.ip) return null;
    const computer = await resolveComputer(session.ip);
    if (computer.id !== session.computerId) return null;
    return { ...session, computer };
  }

  function cookie(sessionId) {
    return `${PORTAL_COOKIE}=${encodeURIComponent(sessionId)}; Path=/api/portal; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${cookieSecure ? "; Secure" : ""}`;
  }

  function expiredCookie() {
    return `${PORTAL_COOKIE}=; Path=/api/portal; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure ? "; Secure" : ""}`;
  }

  async function listCertificates(query = {}) {
    return certificatesService.listCertificates({ db, query });
  }

  async function createRequest(session, input = {}) {
    const certificateId = Number(input.certificadoId);
    if (!Number.isInteger(certificateId) || certificateId <= 0) throw makeError("INVALID_CERTIFICATE", "Certificado inv├ílido.");
    const motivo = input.motivo == null ? null : String(input.motivo).trim();
    if (motivo && motivo.length > 500) throw makeError("INVALID_REQUEST", "O motivo excede o limite permitido.");
    const certificate = await db.certificado.findFirst({ where: { id: certificateId, ativo: true }, select: { id: true } });
    if (!certificate) throw makeError("CERTIFICATE_NOT_FOUND", "Certificado n├úo encontrado.");
    const duplicate = await db.solicitacaoCertificado.findFirst({ where: { computadorId: session.computerId, certificadoId: certificateId, estado: "PENDENTE" }, select: { protocolo: true } });
    if (duplicate) throw makeError("DUPLICATE_REQUEST", "J├í existe uma solicita├º├úo pendente deste certificado para esta esta├º├úo.");
    let request;
    try {
      request = await db.solicitacaoCertificado.create({
        data: {
          protocolo: `SC-${crypto.randomUUID()}`,
          certificadoId: certificateId,
          computadorId: session.computerId,
          hostnameRegistrado: session.computer.hostname || null,
          usuarioWindowsRegistrado: session.computer.usuario || null,
          ipRegistrado: session.ip,
          motivo: motivo || null
        },
        include: { certificado: true }
      });
    } catch (error) {
      if (error && error.code === "P2002") throw makeError("DUPLICATE_REQUEST", "J├í existe uma solicita├º├úo pendente deste certificado para esta esta├º├úo.");
      throw error;
    }
    return publicPortalRequest(request);
  }

  async function listOwnRequests(session, query = {}) {
    const page = Math.max(1, Number.parseInt(query.page || "1", 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize || String(PAGE_SIZE), 10) || PAGE_SIZE));
    const where = { computadorId: session.computerId };
    const [total, requests] = await Promise.all([
      db.solicitacaoCertificado.count({ where }),
      db.solicitacaoCertificado.findMany({ where, orderBy: [{ solicitadoEm: "desc" }, { id: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { certificado: true } })
    ]);
    return { items: requests.map((request) => publicPortalRequest(request, certificateRelease)), total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async function listRequests() {
    const requests = await db.solicitacaoCertificado.findMany({ orderBy: [{ solicitadoEm: "desc" }, { id: "desc" }], include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
    return requests.map((request) => publicAdminRequest(request, certificateRelease));
  }

  async function pendingRequestSummary() {
    const where = { estado: "PENDENTE" };
    const [pendentes, latest] = await Promise.all([
      db.solicitacaoCertificado.count({ where }),
      db.solicitacaoCertificado.findFirst({ where, orderBy: [{ solicitadoEm: "desc" }, { id: "desc" }], select: { id: true, solicitadoEm: true } })
    ]);
    return { pendentes, ultimaSolicitacaoId: latest?.id ?? null, ultimaSolicitacaoEm: latest?.solicitadoEm ?? null };
  }

  async function decideRequest(id, input, actor) {
    const requestId = Number(id);
    const estado = String(input && input.estado || "").trim().toUpperCase();
    if (!Number.isInteger(requestId) || requestId <= 0) throw makeError("INVALID_ID", "Solicita├º├úo inv├ílida.");
    if (!["APROVADA", "NEGADA"].includes(estado)) throw makeError("INVALID_STATE", "Estado inv├ílido.");
    const motivoNegativa = input && input.motivoNegativa == null ? "" : String(input.motivoNegativa || "").trim();
    if (estado === "NEGADA" && !motivoNegativa) throw makeError("DENIAL_REASON_REQUIRED", "O motivo da negativa ├® obrigat├│rio.");
    if (motivoNegativa.length > 500) throw makeError("INVALID_REQUEST", "O motivo da negativa excede o limite permitido.");
    if (estado === "APROVADA") {
        const released = await certificateRelease.releaseRequest(requestId, actor);
        if (!released.__alreadyReleased) publishBrowserNotification(browserNotifications, "publishComputer", released.computadorId, "CERTIFICATE_RELEASED");
        return publicAdminRequest(released, certificateRelease);
      }
    const result = await db.solicitacaoCertificado.updateMany({
      where: { id: requestId, estado: "PENDENTE" },
      data: { estado, analisadoEm: new Date(now()), analisadoPor: String(actor || "ADMIN"), motivoNegativa: estado === "NEGADA" ? motivoNegativa : null }
    });
    if (result.count !== 1) {
      const current = await db.solicitacaoCertificado.findUnique({ where: { id: requestId }, select: { id: true, estado: true } });
      if (!current) throw makeError("NOT_FOUND", "Solicita├º├úo n├úo encontrada.");
      throw makeError("INVALID_TRANSITION", "A solicita├º├úo n├úo est├í pendente.");
    }
    const updated = await db.solicitacaoCertificado.findUnique({ where: { id: requestId }, include: { certificado: true, computador: { select: { id: true, hostname: true, ip: true, usuario: true } } } });
    return publicAdminRequest(updated, certificateRelease);
  }

  return { normalizeIp, resolveComputer, createSession, getSession, cookie, expiredCookie, listCertificates, createRequest, listOwnRequests, listRequests, pendingRequestSummary, decideRequest, releaseRequest: certificateRelease.releaseRequest, cleanup, _sessions: sessions };
}

function publicPortalRequest(request, releaseService) {
  const release = releaseService?.publicRelease(request);
  return {
    id: request.id,
    protocolo: request.protocolo,
    estado: request.estado,
    motivo: request.motivo,
    solicitadoEm: request.solicitadoEm,
    analisadoEm: request.analisadoEm,
    ...(request.estado === "NEGADA" ? { motivoNegativa: request.motivoNegativa } : {}),
    ...(release ? { liberacao: release } : {}),
    certificado: request.certificado ? certificatesService.publicCertificate(request.certificado) : null
  };
}

function publicAdminRequest(request, releaseService) {
  const release = releaseService?.publicRelease(request);
  return {
    id: request.id,
    protocolo: request.protocolo,
    estado: request.estado,
    motivo: request.motivo,
    motivoNegativa: request.motivoNegativa,
    solicitadoEm: request.solicitadoEm,
    analisadoEm: request.analisadoEm,
    analisadoPor: request.analisadoPor,
    liberacao: release,
    liberacaoPendente: request.estado === "APROVADA" && !release,
    certificado: request.certificado ? certificatesService.publicCertificate(request.certificado) : null,
    computador: request.computador ? { id: request.computador.id, hostname: request.computador.hostname, ip: request.computador.ip, usuario: request.computador.usuario } : null
  };
}

module.exports = { createPortalService, normalizeIp, PORTAL_COOKIE, SESSION_TTL_MS, SESSION_MAX_AGE_SECONDS, PORTAL_STATES };
