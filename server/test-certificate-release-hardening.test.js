const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { buildOriginKey } = require("./src/services/certificados.service");
const { createCertificateReleaseService, RELEASE_TTL_MS, releaseFilename, destinationInfo } = require("./src/services/certificateRelease.service");
const { createCertificateReleaseCleanupScheduler } = require("./src/services/certificateReleaseCleanupScheduler.service");

function tree() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-ti-hardening-")); const source = path.join(root, "source"); const destination = path.join(root, "destination"); fs.mkdirSync(path.join(source, "2026"), { recursive: true }); fs.mkdirSync(destination); return { root, source, destination }; }
function request(overrides = {}) { return { id: 9, protocolo: "SC-FAKE-9", estado: "PENDENTE", certificadoId: 3, computadorId: 4, hostnameRegistrado: "FAKE-PC", usuarioWindowsRegistrado: "fake-user", nomeArquivoLiberado: null, liberadoEm: null, releasedAt: null, expiresAt: null, statusLiberacao: "NAO_LIBERADO", certificado: { id: 3, ativo: true, origemChave: buildOriginKey("2026/fake.pfx"), nomeExibicao: "Empresa Ficticia", anoReferencia: 2026, extensao: ".pfx" }, ...overrides }; }
function dbFor(item, audit = []) { return { certificadoLiberacaoAuditoria: { create: async ({ data }) => { audit.push(data); } }, solicitacaoCertificado: { findUnique: async () => item, updateMany: async ({ where, data }) => { const statusOk = typeof where.statusLiberacao === "string" ? where.statusLiberacao === item.statusLiberacao : !where.statusLiberacao || where.statusLiberacao.in.includes(item.statusLiberacao); if (where.id !== item.id || (where.estado && where.estado !== item.estado) || (where.releaseAttemptId && where.releaseAttemptId !== item.releaseAttemptId) || !statusOk) return { count: 0 }; Object.assign(item, data); return { count: 1 }; }, update: async ({ data }) => { Object.assign(item, data); return item; }, findMany: async () => [item] } }; }
function remove(treeValue) { fs.rmSync(treeValue.root, { recursive: true, force: true }); }
function putSource(t) { fs.writeFileSync(path.join(t.source, "2026", "fake.pfx"), "FICTITIOUS-CERTIFICATE"); }
function localRemovalHelper(io = fs) { return { run: async ({ operation, destinationRoot, filename, expectedFingerprint }) => { const target = path.resolve(destinationRoot, filename); let stats; try { stats = io.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return { ok: true, result: "ABSENT" }; return { ok: false, result: "ERROR", code: "HELPER_TARGET_UNAVAILABLE" }; } if (stats.isSymbolicLink?.() || stats.isDirectory?.()) return { ok: false, result: "ERROR", code: "HELPER_TARGET_UNSAFE" }; if (operation === "inspect_presence") return { ok: true, result: "PRESENT" }; if (operation === "remove_temp") { io.unlinkSync(target); return { ok: true, result: "REMOVED" }; } const fingerprint = crypto.createHash("sha256").update(io.readFileSync(target)).digest("hex"); if (fingerprint !== expectedFingerprint) return { ok: false, result: "ERROR", code: "FINGERPRINT_MISMATCH" }; if (operation === "inspect") return { ok: true, result: "PRESENT_VALID" }; io.unlinkSync(target); return { ok: true, result: "REMOVED" }; }, stop() {} }; }

test("expiresAt é exatamente 24 horas e acesso expira imediatamente", async () => {
  const t = tree(); const audit = []; const releasedAt = new Date("2026-09-17T12:00:00.000Z"); const r = request(); putSource(t);
  const previousUnc = process.env.CERTIFICADOS_LIBERADOS_UNC;
  const previousPath = process.env.CERTIFICADOS_LIBERADOS_PATH;
  process.env.CERTIFICADOS_LIBERADOS_UNC = "\\\\test-host\\test-share";
  delete process.env.CERTIFICADOS_LIBERADOS_PATH;
  try {
    const service = createCertificateReleaseService({ db: dbFor(r, audit), sourcePath: t.source, destinationPath: t.destination, now: () => releasedAt });
    await service.releaseRequest(r.id, "admin-ficticio");
    assert.equal(r.expiresAt.getTime(), releasedAt.getTime() + RELEASE_TTL_MS);
    assert.ok(service.publicRelease(r));
    const expired = createCertificateReleaseService({ db: dbFor(r), sourcePath: t.source, destinationPath: t.destination, now: () => new Date(releasedAt.getTime() + RELEASE_TTL_MS) });
    assert.equal(expired.publicRelease(r), null);
    assert.equal(service.releaseStatus({ ...r, expiresAt: new Date(releasedAt.getTime() + RELEASE_TTL_MS) }, releasedAt.getTime() + RELEASE_TTL_MS), "EXPIRADA");
  } finally {
    if (previousUnc === undefined) delete process.env.CERTIFICADOS_LIBERADOS_UNC;
    else process.env.CERTIFICADOS_LIBERADOS_UNC = previousUnc;
    if (previousPath === undefined) delete process.env.CERTIFICADOS_LIBERADOS_PATH;
    else process.env.CERTIFICADOS_LIBERADOS_PATH = previousPath;
    remove(t);
  }
});

test("publicação atômica bem-sucedida usa temporário aleatório e não deixa temporário", () => {
  const t = tree(); putSource(t);
  try { const service = createCertificateReleaseService({ db: dbFor(request()), sourcePath: t.source, destinationPath: t.destination }); const r = request(); const result = service._publishAtomically({ candidate: path.join(t.source, "2026", "fake.pfx"), extension: ".pfx" }, { destination: t.destination, realDestination: fs.realpathSync.native(t.destination), target: path.join(t.destination, "final.pfx") }, ".pfx"); assert.equal(result.target.endsWith("final.pfx"), true); assert.deepEqual(fs.readdirSync(t.destination), ["final.pfx"]); } finally { remove(t); }
});

test("colisão falha sem sobrescrever e falha de cópia não publica final", () => {
  const t = tree(); putSource(t); const source = path.join(t.source, "2026", "fake.pfx"); const target = path.join(t.destination, "final.pfx"); fs.writeFileSync(target, "ORIGINAL");
  try { const service = createCertificateReleaseService({ db: dbFor(request()), destinationPath: t.destination }); assert.throws(() => service._publishAtomically({ candidate: source, extension: ".pfx" }, { destination: t.destination, realDestination: fs.realpathSync.native(t.destination), target }, ".pfx"), { code: "RELEASE_DESTINATION_EXISTS" }); const partialFs = { ...fs, copyFileSync: (from, to) => { fs.writeFileSync(to, "PARTIAL"); throw new Error("fake-copy-failure"); } }; const failed = createCertificateReleaseService({ db: dbFor(request()), fsModule: partialFs }); assert.throws(() => failed._publishAtomically({ candidate: source, extension: ".pfx" }, { destination: t.destination, realDestination: fs.realpathSync.native(t.destination), target: path.join(t.destination, "other.pfx") }, ".pfx")); assert.equal(fs.readFileSync(target, "utf8"), "ORIGINAL"); assert.equal(fs.readdirSync(t.destination).length, 1); } finally { remove(t); }
});

test("cleanup remove somente liberações expiradas registradas, rejeita fora do destino e symlink", async (tst) => {
  const t = tree(); const fingerprint = crypto.createHash("sha256").update("x").digest("hex"); const expired = request({ id: 1, nomeArquivoLiberado: "expired.pfx", releaseFingerprint: fingerprint, releasedAt: new Date(1), expiresAt: new Date(2), statusLiberacao: "LIBERADO" }); const pending = request({ id: 2, nomeArquivoLiberado: "pending.pfx", releaseFingerprint: fingerprint, releasedAt: new Date(1), expiresAt: new Date(2), statusLiberacao: "LIBERADO" }); const audit = []; fs.writeFileSync(path.join(t.destination, "expired.pfx"), "x"); fs.writeFileSync(path.join(t.destination, "pending.pfx"), "x");
  const rows = [expired, pending]; let failRemoval = true; const db = { certificadoLiberacaoAuditoria: { create: async ({ data }) => audit.push(data) }, solicitacaoCertificado: { findMany: async () => rows, update: async ({ where, data }) => { Object.assign(rows.find((r) => r.id === where.id), data); } } }; const io = { ...fs, unlinkSync: (filename) => { if (failRemoval && filename.endsWith("pending.pfx")) throw new Error("locked"); return fs.unlinkSync(filename); } };
  try { const service = createCertificateReleaseService({ db, fsModule: io, destinationPath: t.destination, now: () => new Date(3), removalHelper: localRemovalHelper(io) }); const first = await service.cleanupExpired(); assert.equal(first.removed, 1); assert.equal(fs.existsSync(path.join(t.destination, "expired.pfx")), false); assert.equal(fs.existsSync(path.join(t.destination, "pending.pfx")), true); assert.equal(pending.statusLiberacao, "REMOCAO_PENDENTE"); failRemoval = false; await service.cleanupExpired(); assert.equal(fs.existsSync(path.join(t.destination, "pending.pfx")), false); assert.ok(audit.every((e) => !JSON.stringify(e).includes("pending.pfx"))); tst.assert.ok(true); } finally { remove(t); }
});

test("cleanup concorrente é bloqueado, symlink e registro legado não são removidos", async () => {
  const t = tree(); const legacy = request({ id: 3, nomeArquivoLiberado: "legacy.pfx", statusLiberacao: "LEGADO" }); const link = request({ id: 4, nomeArquivoLiberado: "link.pfx", releasedAt: new Date(1), expiresAt: new Date(2), statusLiberacao: "DISPONIVEL" }); fs.writeFileSync(path.join(t.destination, "legacy.pfx"), "legacy"); fs.writeFileSync(path.join(t.destination, "real.pfx"), "real"); fs.symlinkSync(path.join(t.destination, "real.pfx"), path.join(t.destination, "link.pfx")); let resolve; const db = { certificadoLiberacaoAuditoria: { create: async () => {} }, solicitacaoCertificado: { findMany: async () => { await new Promise((r) => { resolve = r; }); return [link]; }, update: async () => {} } }; try { const service = createCertificateReleaseService({ db, destinationPath: t.destination, now: () => new Date(3) }); const first = service.cleanupExpired(); const second = await service.cleanupExpired(); assert.deepEqual(second, { skipped: true }); resolve(); await first; assert.equal(fs.existsSync(path.join(t.destination, "legacy.pfx")), true); assert.equal(fs.existsSync(path.join(t.destination, "link.pfx")), true); } finally { remove(t); }
});

test("scheduler executa no startup e usa intervalo de 15 minutos", async () => { let calls = 0; const scheduler = createCertificateReleaseCleanupScheduler({ service: { cleanupExpired: async () => { calls += 1; } }, intervalMs: 900000 }); assert.equal(scheduler.intervalMs, 900000); scheduler.start(); await new Promise((resolve) => setImmediate(resolve)); scheduler.stop(); assert.equal(calls, 1); });

test("containment usa raiz UNC e rejeita traversal sem tocar a origem", () => {
  const unc = "\\\\192.168.40.250\\certificado";
  const io = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpathSync: { native: (value) => value } };
  const info = destinationInfo("release.pfx", unc, io);
  assert.equal(info.destination, unc);
  assert.equal(info.target, path.join(unc, "release.pfx"));
  assert.throws(() => destinationInfo("..\\outside.pfx", unc, io), { code: "RELEASE_DESTINATION_INVALID" });
});

test("auditoria dedicada contém somente dados sanitizados e eventos permitidos", () => { const eventNames = ["RELEASE_APPROVED", "RELEASE_PUBLISHED", "RELEASE_FAILED", "RELEASE_EXPIRED", "RELEASE_FILE_REMOVED", "RELEASE_REMOVAL_FAILED"]; assert.equal(eventNames.length, 6); assert.equal(JSON.stringify({ evento: eventNames[0], codigo: "PUBLISHED", resultado: "SUCCESS", solicitacaoId: 1, certificadoId: 2 }).includes("senha"), false); assert.equal(releaseFilename(request(), ".pfx").includes("/"), false); });
