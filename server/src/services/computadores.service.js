const prisma = require("../prisma");
const { normalizeOfficeInstallations } = require("../inventory/officeNormalization");

class ComputerDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputerDeletionError";
    this.code = code;
  }
}

const ADMIN_IDENTITY_FIELDS = new Set(["apelido", "equipamentoNumero"]);
const MAX_APELIDO_LENGTH = 120;
const MAX_EQUIPMENT_NUMBER_LENGTH = 64;

function normalizeAdminField(value, maxLength, field) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ComputerDeletionError("INVALID_METADATA", `${field} deve ser texto.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ComputerDeletionError("INVALID_METADATA", `${field} excede o limite permitido.`);
  return normalized || null;
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
    apelido: c.apelido || null,
    equipamentoNumero: c.equipamentoNumero || null,
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
        installations: officeInstallations,
        ...(officeInstallations.length ? { normalized: normalizeOfficeInstallations(officeInstallations) } : {})
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

async function updateInventoryMetadata(value, input, db = prisma) {
  const id = parseComputerId(value);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ComputerDeletionError("INVALID_METADATA", "Dados de identificação inválidos.");
  if (Object.keys(input).some((field) => !ADMIN_IDENTITY_FIELDS.has(field))) throw new ComputerDeletionError("INVALID_METADATA", "Campo de identificação inválido.");
  if (!Object.keys(input).length) throw new ComputerDeletionError("INVALID_METADATA", "Informe ao menos um campo.");
  const data = {
    apelido: normalizeAdminField(input.apelido, MAX_APELIDO_LENGTH, "Apelido"),
    equipamentoNumero: normalizeAdminField(input.equipamentoNumero, MAX_EQUIPMENT_NUMBER_LENGTH, "Número do equipamento")
  };
  Object.keys(data).forEach((field) => data[field] === undefined && delete data[field]);
  try {
    return mapComputador(await db.computador.update({ where: { id }, data }));
  } catch (error) {
    if (error && error.code === "P2025") throw new ComputerDeletionError("NOT_FOUND", "Computador não encontrado.");
    if (error && error.code === "P2002") throw new ComputerDeletionError("DUPLICATE_EQUIPMENT", "Número do equipamento já está vinculado a outro computador.");
    throw error;
  }
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
  createComputadoresService: ({ db = prisma } = {}) => ({ list: () => list(db), getById: (id) => getById(id, db), updateInventoryMetadata: (id, input) => updateInventoryMetadata(id, input, db), getInventoryComparison: (id) => getInventoryComparison(id, db) }),
  updateInventoryMetadata,
  getCapabilitiesById,
  deleteOfflineComputer,
  ComputerDeletionError
};
