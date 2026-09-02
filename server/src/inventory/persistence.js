const prisma = require("../prisma");
const { validateInventoryMessage, MAX_STRING_LENGTH } = require("./office");

const MAX_PAST_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const computerLocks = new Map();

function normalizeCollectedAt(value, now) {
  const parsed = new Date(value);
  const timestamp = parsed.getTime();
  const current = now.getTime();
  if (!Number.isFinite(timestamp) || timestamp < current - MAX_PAST_MS || timestamp > current + MAX_FUTURE_MS) return now;
  return parsed;
}

function safeField(value) {
  if (value == null) return null;
  const result = String(value).trim();
  return result && result.length <= MAX_STRING_LENGTH ? result : null;
}

function installationData(item) {
  return {
    source: safeField(item.source),
    productReleaseId: safeField(item.productReleaseId),
    productName: safeField(item.productName),
    edition: safeField(item.edition),
    version: safeField(item.version),
    architecture: safeField(item.architecture),
    updateChannel: safeField(item.updateChannel),
    installationTechnology: safeField(item.installationTechnology),
    activationStatus: safeField(item.activationStatus),
    rawStatusCode: safeField(item.rawStatusCode),
    licenseType: safeField(item.licenseType),
    licenseName: safeField(item.licenseName),
    licenseDescription: safeField(item.licenseDescription),
    partialProductKey: /^[A-Za-z0-9]{5}$/.test(String(item.partialProductKey || "")) ? item.partialProductKey : null,
    fingerprint: safeField(item.fingerprint)
  };
}

function enqueueComputer(computerId, operation) {
  const key = String(computerId);
  const previous = computerLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  const cleanup = current.finally(() => {
    if (computerLocks.get(key) === cleanup) computerLocks.delete(key);
  });
  computerLocks.set(key, cleanup);
  return cleanup;
}

function persistOfficeInventory({ db = prisma, computadorId, office, now = new Date() } = {}) {
  const deviceId = "persistence-validation";
  const validation = validateInventoryMessage({ type: "inventory", deviceId, data: { office } }, null);
  if (!validation.ok) {
    const error = new Error("Inventário Office inválido.");
    error.code = validation.reason;
    return Promise.reject(error);
  }

  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return Promise.reject(new Error("Timestamp do servidor inválido."));
  return enqueueComputer(computadorId, () => db.$transaction(async (tx) => {
    const computer = await tx.computador.findUnique({ where: { id: Number(computadorId) }, select: { id: true } });
    if (!computer) {
      const error = new Error("Computador não encontrado.");
      error.code = "computer_not_found";
      throw error;
    }

    const collectedAt = normalizeCollectedAt(office.collectedAt, current);
    const fingerprints = [];
    for (const item of office.installations) {
      const data = installationData(item);
      if (!data.fingerprint || fingerprints.includes(data.fingerprint)) continue;
      fingerprints.push(data.fingerprint);
      await tx.officeInstallation.upsert({
        where: { computadorId_fingerprint: { computadorId: computer.id, fingerprint: data.fingerprint } },
        create: { ...data, computadorId: computer.id, firstSeenAt: collectedAt, lastSeenAt: current, collectedAt, isPresent: true },
        update: { ...data, lastSeenAt: current, collectedAt, isPresent: true }
      });
    }

    const where = fingerprints.length
      ? { computadorId: computer.id, fingerprint: { notIn: fingerprints } }
      : { computadorId: computer.id };
    await tx.officeInstallation.updateMany({ where, data: { isPresent: false } });
    return { computadorId: computer.id, installationsReceived: fingerprints.length };
  }));
}

module.exports = { MAX_PAST_MS, MAX_FUTURE_MS, normalizeCollectedAt, installationData, persistOfficeInventory };
