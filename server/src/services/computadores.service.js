const prisma = require("../prisma");

class ComputerDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputerDeletionError";
    this.code = code;
  }
}

function mapComputador(c, includeOffice = false) {
  const officeInstallations = includeOffice ? (c.officeInstallations || []).map((installation) => ({
    id: installation.id,
    source: installation.source,
    productReleaseId: installation.productReleaseId,
    productName: installation.productName,
    edition: installation.edition,
    version: installation.version,
    architecture: installation.architecture,
    updateChannel: installation.updateChannel,
    installationTechnology: installation.installationTechnology,
    activationStatus: installation.activationStatus,
    rawStatusCode: installation.rawStatusCode,
    licenseType: installation.licenseType,
    licenseName: installation.licenseName,
    licenseDescription: installation.licenseDescription,
    partialProductKey: installation.partialProductKey == null ? null : String(installation.partialProductKey).slice(-5),
    firstSeenAt: installation.firstSeenAt,
    lastSeenAt: installation.lastSeenAt,
    collectedAt: installation.collectedAt
  })) : [];

  return {
    id: c.id,
    deviceId: c.deviceId,
    hostname: c.hostname,
    usuario: c.usuario,
    ip: c.ip,
    sistema: c.sistema,
    arquitetura: c.arquitetura,
    processador: c.processador,
    cpusLogicas: c.cpusLogicas,
    sistemaRelease: c.sistemaRelease,
    fabricante: c.fabricante,
    modeloEquipamento: c.modeloEquipamento,
    placaMaeFabricante: c.placaMaeFabricante,
    placaMaeModelo: c.placaMaeModelo,
    biosFabricante: c.biosFabricante,
    biosVersao: c.biosVersao,
    numeroSerie: c.numeroSerie,
    agentVersion: c.agentVersion,
    status: c.status,
    ultimaConexao: c.ultimaConexao,
    cpuUso: c.cpuUso,
    ramTotal: c.ramTotal,
    ramUsada: c.ramUsada,
    discoTotal: c.discoTotal,
    discoLivre: c.discoLivre,
    uptime: c.uptime,
    ultimaMetrica: c.ultimaMetrica,
    ...(includeOffice ? {
      office: {
        // Sem um marcador de coleta no modelo, zero registros é indeterminado.
        available: officeInstallations.length > 0 ? true : null,
        inventoryStatus: officeInstallations.length > 0 ? "reported" : "unknown",
        installations: officeInstallations
      }
    } : {}),
    discosFisicos: (c.discosFisicos || []).map((d) => ({
      id: d.id,
      modelo: d.modelo,
      tamanho: d.tamanho,
      interface: d.interface
    }))
  };
}

async function list(db = prisma) {
  const items = await db.computador.findMany({
    orderBy: { hostname: "asc" }
  });

  return items.map((item) => mapComputador(item));
}

async function getById(id, db = prisma) {
  const c = await db.computador.findUnique({
    where: { id: Number(id) },
    include: {
      discosFisicos: true,
      officeInstallations: {
        where: { isPresent: true },
        orderBy: { id: "asc" },
        select: {
          id: true,
          source: true,
          productReleaseId: true,
          productName: true,
          edition: true,
          version: true,
          architecture: true,
          updateChannel: true,
          installationTechnology: true,
          activationStatus: true,
          rawStatusCode: true,
          licenseType: true,
          licenseName: true,
          licenseDescription: true,
          partialProductKey: true,
          firstSeenAt: true,
          lastSeenAt: true,
          collectedAt: true
        }
      }
    }
  });
  return c ? mapComputador(c, true) : null;
}

async function getCapabilitiesById(id) {
  const c = await prisma.computador.findUnique({
    where: { id: Number(id) },
    select: {
      id: true,
      deviceId: true,
      agentVersion: true,
      status: true
    }
  });

  if (!c) return null;

  const agentServer = require("../ws/agentServer");
  const capabilities = agentServer.getCapabilities(c.deviceId);
  return {
    id: c.id,
    deviceId: c.deviceId,
    agentVersion: c.agentVersion,
    status: c.status,
    capabilities,
    notifierReady: agentServer.hasCapability(c.deviceId, "notices"),
    capabilitiesVolatile: true
  };
}

function parseComputerId(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!/^\d+$/.test(raw)) throw new ComputerDeletionError("INVALID_ID", "ID de computador inválido.");
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new ComputerDeletionError("INVALID_ID", "ID de computador inválido.");
  }
  return id;
}

async function deleteOfflineComputer(value, db = prisma) {
  const id = parseComputerId(value);
  return db.$transaction(async (tx) => {
    const computer = await tx.computador.findUnique({
      where: { id },
      select: { id: true, status: true }
    });
    if (!computer) throw new ComputerDeletionError("NOT_FOUND", "Computador não encontrado.");
    if (computer.status !== "offline") {
      throw new ComputerDeletionError("ONLINE", "Computadores online não podem ser excluídos.");
    }

    const activeTarget = await tx.maintenanceScheduleTarget.findFirst({
      where: { computadorId: id, schedule: { enabled: true } },
      select: { scheduleId: true }
    });
    if (activeTarget) {
      throw new ComputerDeletionError(
        "MAINTENANCE",
        "Computadores vinculados a uma manutenção ativa não podem ser excluídos."
      );
    }

    // Revalida imediatamente antes da exclusão e mantém a condição no DELETE.
    const current = await tx.computador.findUnique({
      where: { id },
      select: { status: true }
    });
    if (!current || current.status !== "offline") {
      throw new ComputerDeletionError(
        "ONLINE",
        "O computador deixou de estar offline; exclusão cancelada."
      );
    }

    const deleted = await tx.computador.deleteMany({
      where: { id, status: "offline" }
    });
    if (deleted.count !== 1) {
      throw new ComputerDeletionError(
        "ONLINE",
        "O estado do computador mudou; exclusão cancelada."
      );
    }
    return { id };
  });
}

module.exports = {
  list,
  getById,
  createComputadoresService: ({ db = prisma } = {}) => ({ list: () => list(db), getById: (id) => getById(id, db) }),
  getCapabilitiesById,
  deleteOfflineComputer,
  ComputerDeletionError
};
