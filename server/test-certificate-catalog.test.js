const test = require("node:test");
const assert = require("node:assert/strict");
const { listCertificates } = require("./src/services/certificados.service");

function record(id, name, document, year) {
  return { id, nomeExibicao: name, documentoNormalizado: document, tipoDocumento: document ? "CNPJ" : null, extensao: ".pfx", pastaLogica: String(year), anoReferencia: year, metadataStatus: "PENDENTE" };
}

function database(records) {
  let lastWhere;
  return {
    get lastWhere() { return lastWhere; },
    certificado: {
      count: async ({ where }) => { lastWhere = where; return records.length; },
      findMany: async ({ where, skip, take }) => records.filter((item) => !where.anoReferencia || item.anoReferencia === where.anoReferencia).slice(skip, skip + take)
    }
  };
}

test("pesquisa por nome e pagina sem carregar o catálogo inteiro", async () => {
  const db = database([record(1, "Empresa Alfa", "12345678000199", 2026), record(2, "Empresa Beta", null, 2025)]);
  const result = await listCertificates({ db, query: { q: "Alfa", page: "2", pageSize: "1" } });
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 1);
  assert.equal(db.lastWhere.OR[0].nomePesquisaNormalizado.contains, "alfa");
});

test("pesquisa por documento usa somente dígitos internamente e mantém paginação por ano", async () => {
  const db = database([record(1, "Empresa Alfa", "12345678000199", 2026)]);
  const result = await listCertificates({ db, query: { q: "12.345.678/0001-99", ano: "2026", page: "1", pageSize: "10" } });
  assert.equal(result.items.length, 1);
  assert.equal(db.lastWhere.anoReferencia, 2026);
  assert.equal(db.lastWhere.OR[1].documentoNormalizado.contains, "12345678000199");
  assert.equal(JSON.stringify(result).includes("12345678000199"), false);
});

test("rejeita ano inválido e limita paginação", async () => {
  const db = database([record(1, "Empresa", null, 2026)]);
  await assert.rejects(() => listCertificates({ db, query: { ano: "abc" } }), { code: "INVALID_QUERY" });
  const result = await listCertificates({ db, query: { page: "0", pageSize: "999" } });
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 100);
});
