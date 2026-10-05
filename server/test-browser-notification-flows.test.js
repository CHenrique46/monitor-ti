const test = require("node:test");
const assert = require("node:assert/strict");
const { createPortalService } = require("./src/services/portal.service");

function releaseService(result) {
  return { releaseRequest: async () => result, publicRelease: () => null, releaseStatus: () => "LIBERADO" };
}

test("falha do hub não desfaz criação da solicitação", async () => {
  let created = false;
  const db = {
    certificado: { findFirst: async () => ({ id: 1, ativo: true, validade: null, validadeStatus: null }) },
    solicitacaoCertificado: { findFirst: async () => null, create: async () => { created = true; return { id: 10, protocolo: "SC-10", estado: "PENDENTE", certificado: null }; } },
    $transaction: async (operation) => operation(db)
  };
  const service = createPortalService({ db, releaseService: releaseService({}), browserNotifications: { publishAdmin: () => { throw new Error("hub unavailable"); } } });
  await service.createRequest({ computerId: 7, ip: "127.0.0.1", computer: {} }, { certificadoId: 1 });
  assert.equal(created, true);
});

test("liberação repetida não publica novamente e falha do hub não desfaz release", async () => {
  let published = 0;
  const service = createPortalService({
    db: {},
    releaseService: releaseService({ __alreadyReleased: true, computadorId: 7, id: 10, estado: "APROVADA", certificado: null }),
    browserNotifications: { publishComputer: () => { published += 1; throw new Error("hub unavailable"); } }
  });
  const result = await service.decideRequest(10, { estado: "APROVADA" }, "admin");
  assert.equal(result.estado, "APROVADA");
  assert.equal(published, 0);

  const fresh = createPortalService({
    db: {},
    releaseService: releaseService({ computadorId: 7, id: 10, estado: "APROVADA", certificado: null }),
    browserNotifications: { publishComputer: () => { published += 1; throw new Error("hub unavailable"); } }
  });
  const freshResult = await fresh.decideRequest(10, { estado: "APROVADA" }, "admin");
  assert.equal(freshResult.estado, "APROVADA");
  assert.equal(published, 1);
});
