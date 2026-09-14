const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const service = require("./src/services/certificados.service");
const { requireHumanSession, requireAdmin } = require("./src/auth/middleware");

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mti-certificados-"));
  fs.mkdirSync(path.join(root, "A1 2025"));
  return root;
}

function fakeDb() {
  const records = new Map();
  let nextId = 1;
  return {
    records,
    certificado: {
      findUnique: async ({ where, select }) => {
        const item = [...records.values()].find((record) => record.origemChave === where.origemChave);
        return item ? (select ? { id: item.id, ativo: item.ativo } : { ...item }) : null;
      },
      upsert: async ({ where, create, update }) => {
        const current = [...records.values()].find((record) => record.origemChave === where.origemChave);
        if (current) Object.assign(current, update);
        else records.set(nextId, { id: nextId++, ativo: true, ...create });
        return current || [...records.values()].at(-1);
      },
      findMany: async ({ where, select, orderBy, skip, take }) => {
        let list = [...records.values()];
        if (where?.ativo !== undefined) list = list.filter((record) => record.ativo === where.ativo);
        if (where?.id?.in) list = list.filter((record) => where.id.in.includes(record.id));
        if (orderBy) list.sort((a, b) => a.nomeExibicao.localeCompare(b.nomeExibicao) || a.id - b.id);
        if (take !== undefined) list = list.slice(skip || 0, (skip || 0) + take);
        return list.map((record) => select ? { id: record.id, origemChave: record.origemChave } : { ...record });
      },
      count: async ({ where }) => {
        let list = [...records.values()];
        if (where?.ativo !== undefined) list = list.filter((record) => record.ativo === where.ativo);
        return list.length;
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const record of records.values()) {
          if (where.id.in.includes(record.id)) { Object.assign(record, data); count += 1; }
        }
        return { count };
      },
      findFirst: async ({ where }) => [...records.values()].find((record) => record.id === where.id && record.ativo === where.ativo) || null
    }
  };
}

test("normaliza nomes, remove credencial e não vaza o trecho removido", () => {
  const cleaned = service.cleanDisplayName("Empresa_A-2025 Senha valor-secreto.pfx");
  assert.equal(cleaned, "Empresa A 2025");
  assert.equal(cleaned.includes("valor-secreto"), false);
  assert.equal(service.cleanDisplayName("EMPRESA_SENHA_123456.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("EMPRESASENHA123456.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("Empresa_password=segredo.p12"), "Empresa");
  assert.equal(service.cleanDisplayName("EMPRESA_pwd_X9.p12"), "EMPRESA");
  assert.equal(service.cleanDisplayName("RESENHA CONTABIL LTDA.pfx"), "RESENHA CONTABIL LTDA");
  assert.equal(service.cleanDisplayName("SENHA_123456.pfx"), "Certificado de cliente");
  assert.equal(service.normalizeSearchText(service.cleanDisplayName("EMPRESA password=abc123.pfx")).includes("abc123"), false);
  assert.equal(service.normalizeSearchText("ÁçãO Empresarial_ Ltda"), "acao empresarial ltda");
});

test("sanitiza documentos, códigos, validade e preserva números empresariais", () => {
  assert.equal(service.cleanDisplayName("EMPRESA_11222333000181.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("EMPRESA_11.222.333/0001-81.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("11222333000181_EMPRESA.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("529.982.247-25_EMPRESA.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("123_EMPRESA.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("EMPRESA_valid 04 08 27.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("EMPRESA_venc 04-08-2027.pfx"), "EMPRESA");
  assert.equal(service.cleanDisplayName("EMPRESA Filial 2 Loja 10 3 Irmãos.pfx"), "EMPRESA Filial 2 Loja 10 3 Irmãos");
  assert.equal(service.cleanDisplayName("RESENHA CONTABIL LTDA.pfx"), "RESENHA CONTABIL LTDA");
  assert.equal(service.cleanDisplayName("123456 987654 EMPRESA.pfx"), "EMPRESA");
  assert.equal(service.sanitizePublicBusinessName("123456789.pfx").reviewRequired, true);
});

test("valida CPF/CNPJ e mascara somente documentos válidos", () => {
  assert.equal(service.isValidCpf("529.982.247-25"), true);
  assert.equal(service.isValidCpf("529.982.247-26"), false);
  assert.equal(service.isValidCnpj("11.222.333/0001-81"), true);
  assert.equal(service.isValidCnpj("11.222.333/0001-80"), false);
  assert.deepEqual(service.extractDocument("Empresa_11222333000181.pfx"), { value: "11222333000181", type: "CNPJ" });
  assert.equal(service.extractDocument("Empresa_12345678901234.pfx").value, null);
  assert.equal(service.maskDocument("11222333000181", "CNPJ"), "11.***.***/****-**");
});

test("scan aceita somente pfx/p12 e não atravessa a profundidade permitida", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "A1 2025", "Empresa_11222333000181.pfx"), "");
  fs.writeFileSync(path.join(root, "A1 2025", "ignore.log"), "conteudo não usado");
  fs.mkdirSync(path.join(root, "A1 2025", "subpasta"));
  fs.writeFileSync(path.join(root, "A1 2025", "subpasta", "fora.pfx"), "");
  const result = service.scanCatalog(root);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].extensao, ".pfx");
  assert.equal(result.records[0].anoReferencia, 2025);
  assert.equal(result.records[0].nomeExibicao, "Empresa");
  assert.equal(result.errors.includes("max_depth_reached"), true);
});

test("varredura completa inativa ausentes e varredura parcial preserva ativos", async () => {
  const root = tempRoot();
  const file = path.join(root, "A1 2025", "Empresa A.pfx");
  fs.writeFileSync(file, "");
  const db = fakeDb();
  await service.syncCatalog({ rootPath: root, db });
  const record = [...db.records.values()][0];
  fs.unlinkSync(file);
  const complete = await service.syncCatalog({ rootPath: root, db });
  assert.equal(complete.inativados, 1);
  record.ativo = true;
  fs.mkdirSync(path.join(root, "A1 2025", "subpasta"));
  fs.writeFileSync(path.join(root, "A1 2025", "subpasta", "fora.pfx"), "");
  const partial = await service.syncCatalog({ rootPath: root, db });
  assert.equal(partial.inativados, 0);
  assert.equal(record.ativo, true);
});

test("resposta pública não contém campos internos e middleware rejeita VIEWER", () => {
  const result = service.publicCertificate({
    id: 1,
    nomeExibicao: "Empresa A",
    documentoNormalizado: "11222333000181",
    tipoDocumento: "CNPJ",
    extensao: ".pfx",
    pastaLogica: "A1 2025",
    anoReferencia: 2025,
    metadataStatus: "PENDENTE",
    origemChave: "internal",
    ativo: true
  });
  assert.equal(result.documento, "11.***.***/****-**");
  assert.equal(result.nomeEmpresa, result.nomeExibicao);
  assert.equal(JSON.stringify(result).includes("11222333000181"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "origemChave"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "caminho"), false);

  const response = { statusCode: 0, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const next = () => {};
  const auth = { getRequestSession: () => ({ username: "viewer", role: "VIEWER" }) };
  requireAdmin()(Object.create(null), response, next);
  assert.equal(response.statusCode, 403);
  const req = { headers: {} };
  requireHumanSession(auth)(req, response, next);
  assert.equal(req.humanUser.role, "VIEWER");
});
