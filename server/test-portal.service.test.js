const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createPortalService, normalizeIp, SESSION_MAX_AGE_SECONDS } = require("./src/services/portal.service");
const { createPortalController } = require("./src/controllers/portal.controller");

function certificate(id = 7) {
  return { id, ativo: true, nomeExibicao: `Empresa ${id}`, documentoNormalizado: "12345678000199", tipoDocumento: "CNPJ", extensao: ".pfx", pastaLogica: null, anoReferencia: 2026, metadataStatus: "PENDENTE" };
}

function database(computers = [{ id: 3, ip: "192.168.40.20", hostname: "PC-03", usuario: "tech", status: "online" }], initial = []) {
  const requests = initial.map((item) => ({ estado: "PENDENTE", ...item }));
  return {
    requests,
    computador: { findMany: async ({ where } = {}) => computers.filter((item) => !where?.status || item.status === where.status) },
    certificado: { findFirst: async ({ where }) => where.id === 7 && where.ativo ? certificate() : null, findMany: async () => [certificate()], count: async () => 1 },
    solicitacaoCertificado: {
      findFirst: async ({ where }) => requests.find((item) => item.computadorId === where.computadorId && item.certificadoId === where.certificadoId && (where.estado === item.estado || where.estado?.in?.includes(item.estado))) || null,
      count: async ({ where }) => requests.filter((item) => item.computadorId === where.computadorId).length,
      findMany: async ({ where, orderBy, skip = 0, take = 100 }) => requests.filter((item) => !where?.computadorId || item.computadorId === where.computadorId).sort((a, b) => b.id - a.id).slice(skip, skip + take).map((item) => ({ ...item, certificado: certificate(item.certificadoId) })),
      create: async ({ data }) => { const item = { id: requests.length + 1, estado: "PENDENTE", ...data, certificado: certificate(data.certificadoId) }; requests.push(item); return item; },
      updateMany: async ({ where, data }) => { const item = requests.find((candidate) => candidate.id === where.id && candidate.estado === where.estado); if (!item) return { count: 0 }; Object.assign(item, data); return { count: 1 }; },
      findUnique: async ({ where }) => { const item = requests.find((candidate) => candidate.id === where.id); return item ? { ...item, certificado: certificate(item.certificadoId), computador: computers.find((computer) => computer.id === item.computadorId) } : null; }
    }
  };
}

async function internalSession(service, ip = "192.168.40.20") {
  const created = await service.createSession(ip);
  return service.getSession(created.id, ip);
}

test("valida IP, normaliza IPv4 mapeado e bloqueia loopback, offline e ambiguidade", async () => {
  assert.equal(normalizeIp("192.168.40.20"), "192.168.40.20");
  assert.equal(normalizeIp("::ffff:192.168.40.20"), "192.168.40.20");
  assert.equal(normalizeIp("2001:db8::20"), "2001:db8::20");
  assert.equal(normalizeIp("not-an-ip"), null);
  await assert.rejects(() => createPortalService({ db: database([{ id: 1, ip: "127.0.0.1", status: "online" }]) }).createSession("127.0.0.1"), { code: "PORTAL_LOOPBACK_BLOCKED" });
  await assert.rejects(() => createPortalService({ db: database([{ id: 1, ip: "192.168.40.20", status: "offline" }]) }).createSession("192.168.40.20"), { code: "PORTAL_COMPUTER_NOT_FOUND" });
  await assert.rejects(() => createPortalService({ db: database([{ id: 1, ip: "192.168.40.20", status: "online" }, { id: 2, ip: "192.168.40.20", status: "online" }]) }).createSession("192.168.40.20"), { code: "PORTAL_COMPUTER_AMBIGUOUS" });
  await assert.rejects(() => createPortalService({ db: database() }).createSession("not-an-ip"), { code: "PORTAL_IP_INVALID" });
});

test("usa sessão interna, ignora identidade forjada e produz cookie de 15 minutos", async () => {
  let now = 1000;
  const db = database();
  const service = createPortalService({ db, now: () => now, cookieSecure: true, randomBytes: () => Buffer.alloc(32, 7) });
  const created = await service.createSession("192.168.40.20");
  const token = created.id;
  const session = await service.getSession(token, "192.168.40.20");
  await service.createRequest(session, { certificadoId: 7, computadorId: 999, deviceId: "forged", hostname: "forged", ip: "1.1.1.1" });
  assert.equal(db.requests[0].computadorId, 3);
  assert.equal(db.requests[0].ipRegistrado, "192.168.40.20");
  assert.equal(db.requests[0].hostnameRegistrado, "PC-03");
  assert.match(service.cookie("token"), new RegExp(`Max-Age=${SESSION_MAX_AGE_SECONDS}`));
  assert.match(service.cookie("token"), /HttpOnly/);
  assert.match(service.cookie("token"), /SameSite=Lax/);
  assert.match(service.cookie("token"), /Secure/);
  assert.equal(await service.getSession(token, "192.168.40.21"), null);
  now += 15 * 60 * 1000 + 1;
  assert.equal(await service.getSession(token, "192.168.40.20"), null);
  assert.equal(service._sessions.size, 0);
});

test("lista somente a estação da sessão com paginação e DTO público", async () => {
  const db = database([{ id: 3, ip: "192.168.40.20", hostname: "PC-03", status: "online" }, { id: 4, ip: "192.168.40.21", hostname: "PC-04", status: "online" }], [{ id: 1, computadorId: 3, certificadoId: 7, motivo: "troca", solicitadoEm: new Date() }, { id: 2, computadorId: 4, certificadoId: 7, solicitadoEm: new Date() }]);
  const service = createPortalService({ db });
  const session = await internalSession(service);
  const result = await service.listOwnRequests(session, { page: 1, pageSize: 10, computadorId: 4 });
  assert.deepEqual(result.items.map((item) => item.id), [1]);
  const text = JSON.stringify(result);
  for (const forbidden of ["computadorId", "deviceId", "ipRegistrado", "origemChave", "filename", "senha", "password"]) assert.equal(text.includes(forbidden), false, forbidden);
});

test("portal projeta liberação sem arquivo ou localização e preserva a expiração", async () => {
  const expiresAt = new Date("2026-09-18T12:00:00.000Z");
  const db = database([{ id: 3, ip: "192.168.40.20", hostname: "PC-03", usuario: "tech", status: "online" }], [{ id: 1, computadorId: 3, certificadoId: 7, estado: "APROVADA", statusLiberacao: "LIBERADO" }]);
  const releaseService = { releaseStatus: () => "LIBERADO", publicRelease: () => ({ nomeArquivoLiberado: "secret.pfx", compartilhamento: "\\\\server\\share", liberadoEm: new Date(), releasedAt: new Date(), expiresAt }) };
  const service = createPortalService({ db, releaseService });
  const result = await service.listOwnRequests({ computerId: 3 }, { page: 1, pageSize: 10 });
  assert.deepEqual(result.items[0].liberacao, { liberadoEm: result.items[0].liberacao.liberadoEm, releasedAt: result.items[0].liberacao.releasedAt, expiresAt });
  const text = JSON.stringify(result);
  for (const forbidden of ["nomeArquivoLiberado", "compartilhamento", "\\\\server\\share", "secret.pfx"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.equal(result.items[0].statusLiberacao, "LIBERADO");
});

test("portal expirado não retorna informações do arquivo", async () => {
  const db = database([{ id: 3, ip: "192.168.40.20", hostname: "PC-03", usuario: "tech", status: "online" }], [{ id: 1, computadorId: 3, certificadoId: 7, estado: "APROVADA", statusLiberacao: "LIBERADO" }]);
  const service = createPortalService({ db, releaseService: { releaseStatus: () => "EXPIRADA", publicRelease: () => null } });
  const result = await service.listOwnRequests({ computerId: 3 }, { page: 1, pageSize: 10 });
  assert.equal(result.items[0].statusLiberacao, "EXPIRADA");
  assert.equal(result.items[0].liberacao, undefined);
});

test("apresentação do funcionário não usa cópia, UNC ou erro de compartilhamento", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "dashboard", "src", "components", "PortalCertificados.jsx"), "utf8");
  assert.equal(source.includes("navigator.clipboard"), false);
  assert.equal(source.includes("Copiar compartilhamento"), false);
  assert.equal(source.includes("Não foi possível copiar"), false);
  assert.equal(source.includes("Certificado disponível na pasta Certificados."), true);
  assert.equal(source.includes("Liberação expirada. Faça uma nova solicitação."), true);
});

test("estados, motivo de negativa e transições são restritos", async () => {
  const db = database();
  const service = createPortalService({ db });
  await assert.rejects(() => service.decideRequest(1, { estado: "REJEITADA" }, "admin"), { code: "INVALID_STATE" });
  await assert.rejects(() => service.decideRequest(1, { estado: "CANCELADA" }, "admin"), { code: "INVALID_STATE" });
  await assert.rejects(() => service.decideRequest(1, { estado: "NEGADA", motivoNegativa: "  " }, "admin"), { code: "DENIAL_REASON_REQUIRED" });
  db.requests.push({ id: 1, computadorId: 3, certificadoId: 7, estado: "PENDENTE" });
  const denied = await service.decideRequest(1, { estado: "NEGADA", motivoNegativa: "Não aprovado" }, "admin");
  assert.equal(denied.estado, "NEGADA");
  assert.equal(db.requests.find((item) => item.id === 1).analisadoPor, "admin");
  await assert.rejects(() => service.decideRequest(1, { estado: "APROVADA" }, "admin"), { code: "INVALID_TRANSITION" });
});

test("violação P2002 concorrente vira conflito e cria uma única pendente", async () => {
  let creates = 0;
  const db = database();
  db.solicitacaoCertificado.findFirst = async () => null;
  db.solicitacaoCertificado.create = async ({ data }) => { await new Promise((resolve) => setTimeout(resolve, 5)); creates += 1; if (creates > 1) throw { code: "P2002" }; return { id: 1, estado: "PENDENTE", ...data, certificado: certificate() }; };
  const service = createPortalService({ db });
  const session = await internalSession(service);
  const results = await Promise.allSettled([service.createRequest(session, { certificadoId: 7 }), service.createRequest(session, { certificadoId: 7 })]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected" && item.reason.code === "DUPLICATE_REQUEST").length, 1);
  assert.equal(creates, 2);
});

test("controller expõe listOwnRequests e converte conflito em HTTP 409", async () => {
  const service = { createRequest: async () => { throw { code: "DUPLICATE_REQUEST", message: "duplicado" }; }, listOwnRequests: async () => ({ items: [] }) };
  const controller = createPortalController({ service });
  let statusCode;
  let body;
  const response = { status: (code) => { statusCode = code; return { json: (value) => { body = value; } }; } };
  await controller.createRequest({ portalSession: {} }, response);
  assert.equal(statusCode, 409);
  assert.equal(body.erro, "duplicado");
  assert.equal(typeof controller.listOwnRequests, "function");
});

test("resumo ADMIN conta somente pendentes e retorna apenas o último marcador", async () => {
  const latest = { id: 9, solicitadoEm: new Date("2026-09-15T01:01:00.000Z") };
  const db = {
    solicitacaoCertificado: {
      count: async ({ where }) => { assert.deepEqual(where, { estado: "PENDENTE" }); return 1; },
      findFirst: async (query) => { assert.deepEqual(query.where, { estado: "PENDENTE" }); assert.deepEqual(query.select, { id: true, solicitadoEm: true }); return latest; }
    }
  };
  const service = createPortalService({ db });
  assert.deepEqual(await service.pendingRequestSummary(), { pendentes: 1, ultimaSolicitacaoId: 9, ultimaSolicitacaoEm: latest.solicitadoEm });
  let statusCode;
  let body;
  const controller = createPortalController({ service });
  await controller.pendingRequestSummary({}, { status: (code) => { statusCode = code; return { json: (value) => { body = value; } }; } });
  assert.equal(statusCode, 200);
  assert.deepEqual(body, { pendentes: 1, ultimaSolicitacaoId: 9, ultimaSolicitacaoEm: latest.solicitadoEm });
});

test("controller usa req.ip e ignora X-Forwarded-For e identidade do body", async () => {
  let capturedIp;
  const service = {
    createSession: async (ip) => { capturedIp = ip; return { id: "token", expiresAt: 1600, computer: { hostname: "PC-03", usuario: "tech" } }; },
    cookie: () => "cookie",
  };
  const controller = createPortalController({ service });
  const response = { set: () => {}, status: () => ({ json: () => {} }) };
  await controller.start({ ip: "192.168.40.20", headers: { "x-forwarded-for": "10.0.0.99" }, body: { ip: "10.0.0.99", computadorId: 999, deviceId: "forged" }, secure: false }, response);
  assert.equal(capturedIp, "192.168.40.20");
});

test("logout invalida sessão e ADMIN pode aprovar somente pendente", async () => {
  const db = database();
  db.requests.push({ id: 1, computadorId: 3, certificadoId: 7, estado: "PENDENTE" });
  const service = createPortalService({ db, releaseService: { releaseRequest: async () => { if (db.requests[0].estado !== "PENDENTE") throw Object.assign(new Error("A solicitação não está pendente."), { code: "INVALID_TRANSITION" }); db.requests[0].estado = "APROVADA"; return { ...db.requests[0], certificado: certificate(), computador: { id: 3, hostname: "PC-03", ip: "192.168.40.20", usuario: "tech" } }; }, publicRelease: () => null } });
  const approved = await service.decideRequest(1, { estado: "APROVADA" }, "admin");
  assert.equal(approved.estado, "APROVADA");
  await assert.rejects(() => service.decideRequest(1, { estado: "NEGADA", motivoNegativa: "tarde" }, "admin"), { code: "INVALID_TRANSITION" });
  const created = await service.createSession("192.168.40.20");
  const controller = createPortalController({ service });
  let expiredCookie;
  const response = { set: (name, value) => { if (name === "Set-Cookie") expiredCookie = value; }, status: (code) => ({ end: () => assert.equal(code, 204) }) };
  await controller.logout({ headers: { cookie: `ht_portal_session=${created.id}` } }, response);
  assert.equal(service._sessions.has(created.id), false);
  assert.match(expiredCookie, /Max-Age=0/);
});
