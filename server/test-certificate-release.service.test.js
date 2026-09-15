const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildOriginKey } = require("./src/services/certificados.service");
const { createCertificateReleaseService, resolveOrigin, releaseFilename, safePart } = require("./src/services/certificateRelease.service");

function temporaryTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ti-release-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  fs.mkdirSync(path.join(source, "2026"), { recursive: true });
  fs.mkdirSync(destination);
  return { root, source, destination };
}

function requestFor(sourceRelative = "2026/Empresa.pfx", overrides = {}) {
  return {
    id: 7,
    protocolo: "SC-12345678-aaaa",
    estado: "PENDENTE",
    nomeArquivoLiberado: null,
    liberadoEm: null,
    erroLiberacao: null,
    tentativasLiberacao: 0,
    certificado: { id: 3, ativo: true, origemChave: buildOriginKey(sourceRelative), nomeExibicao: "Empresa Segura", anoReferencia: 2026, extensao: ".pfx" },
    ...overrides
  };
}

function database(request, update = null) {
  return {
    solicitacaoCertificado: {
      findUnique: async () => request,
      update: async ({ data }) => {
        if (update) return update(data);
        for (const [key, value] of Object.entries(data)) request[key] = value && typeof value === "object" && "increment" in value ? request[key] + value.increment : value;
        return request;
      }
    }
  };
}

function cleanup(tree) { fs.rmSync(tree.root, { recursive: true, force: true }); }

test("resolve exatamente uma origem e preserva o algoritmo da origemChave", () => {
  const tree = temporaryTree();
  try {
    const file = path.join(tree.source, "2026", "Empresa.pfx");
    fs.writeFileSync(file, "PFX-TEST");
    const resolved = resolveOrigin(tree.source, buildOriginKey("2026/Empresa.pfx"));
    assert.equal(resolved.extension, ".pfx");
    assert.equal(fs.readFileSync(file, "utf8"), "PFX-TEST");
    assert.throws(() => resolveOrigin(tree.source, buildOriginKey("2026/Ausente.pfx")), { code: "RELEASE_SOURCE_NOT_FOUND" });
  } finally { cleanup(tree); }
});

test("bloqueia origem ambígua por colisão case-insensitive", (t) => {
  const tree = temporaryTree();
  try {
    fs.writeFileSync(path.join(tree.source, "2026", "Empresa.pfx"), "A");
    fs.writeFileSync(path.join(tree.source, "2026", "empresa.pfx"), "B");
    if (fs.readdirSync(path.join(tree.source, "2026")).length < 2) { t.skip("filesystem sem distinção de maiúsculas/minúsculas"); return; }
    assert.throws(() => resolveOrigin(tree.source, buildOriginKey("2026/EMPRESA.PFX")), { code: "RELEASE_SOURCE_AMBIGUOUS" });
  } finally { cleanup(tree); }
});

test("bloqueia symlink e extensão não autorizada", (t) => {
  const tree = temporaryTree();
  try {
    const target = path.join(tree.source, "2026", "Empresa.pfx");
    const link = path.join(tree.source, "2026", "Link.pfx");
    fs.writeFileSync(target, "A");
    try { fs.symlinkSync(target, link); } catch { t.skip("symlink não permitido neste ambiente"); return; }
    assert.throws(() => resolveOrigin(tree.source, buildOriginKey("2026/Link.pfx")), { code: "RELEASE_SOURCE_REPARSE" });
    fs.unlinkSync(link);
    fs.writeFileSync(path.join(tree.source, "2026", "Empresa.txt"), "ignored");
    assert.throws(() => resolveOrigin(tree.source, buildOriginKey("2026/Empresa.txt")), { code: "RELEASE_SOURCE_NOT_FOUND" });
  } finally { cleanup(tree); }
});

test("gera nome Windows seguro sem documento completo nem filename bruto", () => {
  const filename = releaseFilename({ id: 7, protocolo: "SC-12345678-aaaa", certificado: { nomeExibicao: "CON: Empresa / 12345678000199", anoReferencia: 2026 } }, ".p12");
  assert.match(filename, /^CON Empresa-2026-SC-7-5678AAAA\.p12$/);
  assert.equal(filename.includes("12345678000199"), false);
  assert.equal(safePart("CON", "fallback"), "CERT-CON");
  assert.equal(filename.includes("/"), false);
});

test("copia somente após liberação ADMIN e aprova PENDENTE depois do sucesso", async () => {
  const tree = temporaryTree();
  try {
    const source = path.join(tree.source, "2026", "Empresa.pfx");
    fs.writeFileSync(source, "PFX-TEST");
    const request = requestFor();
    const service = createCertificateReleaseService({ db: database(request), sourcePath: tree.source, destinationPath: tree.destination });
    const result = await service.releaseRequest(request.id, "admin");
    assert.equal(result.estado, "APROVADA");
    assert.equal(request.estado, "APROVADA");
    assert.equal(fs.readdirSync(tree.destination).length, 1);
    assert.equal(fs.readFileSync(source, "utf8"), "PFX-TEST");
    assert.equal(request.nomeArquivoLiberado.includes("12345678000199"), false);
  } finally { cleanup(tree); }
});

test("NEGADA, certificado inativo e destino existente não liberam", async () => {
  const tree = temporaryTree();
  try {
    fs.writeFileSync(path.join(tree.source, "2026", "Empresa.pfx"), "A");
    await assert.rejects(() => createCertificateReleaseService({ db: database(requestFor("2026/Empresa.pfx", { estado: "NEGADA" })), sourcePath: tree.source, destinationPath: tree.destination }).releaseRequest(7, "admin"), { code: "INVALID_TRANSITION" });
    await assert.rejects(() => createCertificateReleaseService({ db: database(requestFor("2026/Empresa.pfx", { certificado: { ...requestFor().certificado, ativo: false } })), sourcePath: tree.source, destinationPath: tree.destination }).releaseRequest(7, "admin"), { code: "RELEASE_REVIEW_REQUIRED" });
    const request = requestFor();
    const service = createCertificateReleaseService({ db: database(request), sourcePath: tree.source, destinationPath: tree.destination });
    const filename = service._releaseFilename(request, ".pfx");
    fs.writeFileSync(path.join(tree.destination, filename), "existing");
    await assert.rejects(() => service.releaseRequest(7, "admin"), { code: "RELEASE_DESTINATION_EXISTS" });
    assert.equal(fs.readFileSync(path.join(tree.destination, filename), "utf8"), "existing");
  } finally { cleanup(tree); }
});

test("falha de cópia mantém PENDENTE e banco falho compensa a nova cópia", async () => {
  const tree = temporaryTree();
  try {
    fs.writeFileSync(path.join(tree.source, "2026", "Empresa.pfx"), "A");
    const failedCopyFs = { ...fs, copyFileSync: () => { throw new Error("copy failed"); } };
    const failedRequest = requestFor();
    await assert.rejects(() => createCertificateReleaseService({ db: database(failedRequest), fsModule: failedCopyFs, sourcePath: tree.source, destinationPath: tree.destination }).releaseRequest(7, "admin"), { code: "RELEASE_FAILED" });
    assert.equal(failedRequest.estado, "PENDENTE");
    assert.equal(failedRequest.erroLiberacao, "RELEASE_FAILED");
    const dbFailedRequest = requestFor();
    const dbFailed = database(dbFailedRequest, () => { throw new Error("db failed"); });
    await assert.rejects(() => createCertificateReleaseService({ db: dbFailed, sourcePath: tree.source, destinationPath: tree.destination }).releaseRequest(7, "admin"), { code: "RELEASE_FAILED" });
    assert.equal(fs.readdirSync(tree.destination).length, 0);
  } finally { cleanup(tree); }
});

test("chamadas concorrentes resultam em uma única cópia e aprovação antiga exige liberação explícita", async () => {
  const tree = temporaryTree();
  try {
    fs.writeFileSync(path.join(tree.source, "2026", "Empresa.pfx"), "A");
    const request = requestFor();
    const service = createCertificateReleaseService({ db: database(request), sourcePath: tree.source, destinationPath: tree.destination });
    await Promise.all([service.releaseRequest(7, "admin"), service.releaseRequest(7, "admin")]);
    assert.equal(fs.readdirSync(tree.destination).length, 1);
    assert.equal(request.estado, "APROVADA");
    const legacy = requestFor("2026/Empresa.pfx", { id: 8, estado: "APROVADA" });
    const legacyService = createCertificateReleaseService({ db: database(legacy), sourcePath: tree.source, destinationPath: tree.destination });
    await legacyService.releaseRequest(8, "admin");
    assert.equal(legacy.estado, "APROVADA");
    assert.ok(legacy.liberadoEm);
  } finally { cleanup(tree); }
});
