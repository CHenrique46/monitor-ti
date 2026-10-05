const test = require("node:test");
const assert = require("node:assert/strict");
const service = require("./src/services/certificados.service");
const { createPortalService } = require("./src/services/portal.service");

const NOW = new Date("2026-09-17T15:00:00.000Z");

test("extrai validade confirmada depois de Validade ou Vencimento sem confundir documento", () => {
  const names = [
    "Empresa Validade 17.09.2027.pfx",
    "Empresa Validade_17.09.2027.pfx",
    "Empresa Validade-17-09-2027.pfx",
    "Empresa Validade 17/09/2027.pfx",
    "Empresa Vencimento 17.09.2027.pfx",
    "EMPRESA vencimento 17.09.2027.pfx",
    "ACME TESTE_12345678000195_Validade 17.09.2027 Senha 99887766.pfx",
    "ACME TESTE_Senha 99887766_Validade 17.09.2027.pfx"
  ];
  for (const name of names) {
    const result = service.extractValidityMetadata(name, new Date("2026-09-17T15:00:00.000Z"), NOW);
    assert.equal(result.validade.toISOString(), "2027-09-17T12:00:00.000Z", name);
    assert.equal(result.validadeOrigem, "CONFIRMADA_NOME", name);
    assert.equal(result.validadeStatus, "VALIDO_CONFIRMADO", name);
  }
  const publicRecord = service.publicCertificate({ id: 1, nomeExibicao: "ACME TESTE", documentoNormalizado: null, tipoDocumento: null, extensao: ".pfx", pastaLogica: null, anoReferencia: 2027, validade: new Date("2027-09-17T12:00:00.000Z"), validadeOrigem: "CONFIRMADA_NOME", validadeStatus: "VALIDO_CONFIRMADO", origemChave: "hash-only", nomeOriginal: "ACME TESTE_12345678000195_Validade 17.09.2027 Senha 99887766.pfx" });
  const publicText = JSON.stringify(publicRecord);
  assert.equal(publicText.includes("99887766"), false);
  assert.equal(publicText.includes("12345678000195"), false);
  assert.equal(publicText.includes("nomeOriginal"), false);
});

test("datas impossíveis não são confirmadas e datas iguais não são ambíguas", () => {
  const invalid = service.extractValidityMetadata("Empresa Validade 31.02.2027.pfx", new Date("2026-09-17T15:00:00.000Z"), NOW);
  assert.equal(invalid.validadeOrigem, "ESTIMADA_MODIFICACAO");
  const equal = service.parseExplicitValidity("Empresa Validade 17.09.2027 Vencimento 17/09/2027.pfx", NOW);
  assert.equal(equal.status, "VALIDO_CONFIRMADO");
  const conflict = service.parseExplicitValidity("Empresa Validade 17.09.2027 Vencimento 18/09/2027.pfx", NOW);
  assert.equal(conflict.status, "AMBIGUA");
  assert.equal(conflict.date, null);
});

test("fallback usa mtime no fuso civil e soma ano-calendário", () => {
  const regular = service.extractValidityMetadata("Empresa.pfx", new Date("2026-09-17T15:00:00.000Z"), NOW);
  assert.equal(regular.validade.toISOString(), "2027-09-17T12:00:00.000Z");
  assert.equal(regular.validadeOrigem, "ESTIMADA_MODIFICACAO");
  const leap = service.extractValidityMetadata("Empresa.p12", new Date("2024-02-29T15:00:00.000Z"), NOW);
  assert.equal(leap.validade.toISOString(), "2025-02-28T12:00:00.000Z");
  const invalid = service.extractValidityMetadata("Empresa.pfx", new Date("invalid"), NOW);
  assert.equal(invalid.validadeStatus, "NAO_IDENTIFICADA");
  const future = service.extractValidityMetadata("Empresa.pfx", new Date("2035-01-01T00:00:00.000Z"), NOW);
  assert.equal(future.validadeStatus, "NAO_IDENTIFICADA");
});

function matchesWhere(record, where) {
  if (!where) return true;
  if (where.AND && !where.AND.every((item) => matchesWhere(record, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(record, item))) return false;
  for (const [key, condition] of Object.entries(where)) {
    if (["AND", "OR"].includes(key)) continue;
    if (condition && typeof condition === "object") {
      if ("contains" in condition && !String(record[key] || "").includes(condition.contains)) return false;
      if ("notIn" in condition && condition.notIn.includes(record[key])) return false;
      if ("gte" in condition && !(record[key] >= condition.gte)) return false;
    } else if (record[key] !== condition) return false;
  }
  return true;
}

function catalogDb(records) {
  return { certificado: {
    count: async ({ where }) => records.filter((record) => matchesWhere(record, where)).length,
    findMany: async ({ where, skip, take }) => records.filter((record) => matchesWhere(record, where)).slice(skip, skip + take)
  } };
}

test("filtro confirmado vencido ocorre antes da paginação e ADMIN pode incluí-lo", async () => {
  const records = [
    { id: 1, nomeExibicao: "Ativo", nomePesquisaNormalizado: "ativo", validadeStatus: "VALIDO_CONFIRMADO", validade: new Date("2027-09-17T12:00:00Z"), ativo: true },
    { id: 2, nomeExibicao: "Vencido", nomePesquisaNormalizado: "vencido", validadeStatus: "VENCIDO_CONFIRMADO", validade: new Date("2025-09-17T12:00:00Z"), ativo: true },
    { id: 3, nomeExibicao: "Desconhecido", nomePesquisaNormalizado: "desconhecido", validadeStatus: null, validade: null, ativo: true }
  ];
  const publicResult = await service.listCertificates({ db: catalogDb(records), query: { page: "1", pageSize: "1" } });
  assert.equal(publicResult.total, 2);
  assert.equal(publicResult.totalPages, 2);
  const adminResult = await service.listCertificates({ db: catalogDb(records), query: { page: "1", pageSize: "10" }, includeConfirmedExpired: true });
  assert.equal(adminResult.total, 3);
});

test("solicitação de confirmado vencido é recusada sem criar registro", async () => {
  let created = false;
  const db = {
    certificado: { findFirst: async () => ({ id: 7, validade: new Date("2025-09-17T12:00:00Z"), validadeStatus: "VALIDO_CONFIRMADO" }) },
    solicitacaoCertificado: { findFirst: async () => null, create: async () => { created = true; } }
  };
  const serviceInstance = createPortalService({ db, releaseService: { publicRelease: () => null, releaseStatus: () => "NAO_LIBERADO" } });
  await assert.rejects(() => serviceInstance.createRequest({ computerId: 3, computer: { hostname: "PILOT", usuario: "user" }, ip: "192.168.40.20" }, { certificadoId: 7 }), { code: "CERTIFICATE_EXPIRED" });
  assert.equal(created, false);
});
