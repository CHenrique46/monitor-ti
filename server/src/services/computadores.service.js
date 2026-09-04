const prisma = require("../prisma");
const { normalizeOfficeInstallations } = require("../inventory/officeNormalization");
const { compareInventory } = require("../inventory/inventoryComparison");
const { enqueueExcelSync } = require("../inventory/excelSyncOutbox");
const { snapshotFromBaseline } = require("../inventory/excelSyncSnapshot");

const OFFICE_PARTIAL_KEY_RE = /^[A-Za-z0-9]{5}$/;

class ComputerDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputerDeletionError";
    this.code = code;
  }
}

class InventoryBaselineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryBaselineError";
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

async function getInventoryComparison(value, db = prisma) {
  const id = parseComputerId(value);
  const computer = await getById(id, db);
  if (!computer) return null;
  const baseline = await db.computerInventoryBaseline.findUnique({ where: { computadorId: id } });
  const excelSync = baseline ? await db.excelInventorySync.findFirst({ where: { baselineId: baseline.id, operation: "UPSERT_INVENTORY" }, orderBy: { id: "desc" }, select: { id: true, status: true } }) : null;
  return {
    computadorId: id,
    equipamentoNumero: computer.equipamentoNumero,
    apelido: computer.apelido,
    hasBaseline: Boolean(baseline),
    comparison: compareInventory(baseline, computer),
    excelSync
  };
}

function normalizeInventoryEquipmentNumber(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) throw new InventoryBaselineError("INVALID_EQUIPMENT", "Número do equipamento inválido.");
    return String(value);
  }
  if (typeof value !== "string") throw new InventoryBaselineError("INVALID_EQUIPMENT", "Número do equipamento inválido.");
  const raw = value.trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new InventoryBaselineError("INVALID_EQUIPMENT", "Número do equipamento inválido.");
  }
  return String(Number(raw));
}

function normalizeInventoryRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InventoryBaselineError("INVALID_REQUEST", "Dados administrativos inválidos.");
  }
  const allowed = new Set(["equipamentoNumero", "apelido"]);
  if (Object.keys(input).some((field) => !allowed.has(field))) {
    throw new InventoryBaselineError("INVALID_REQUEST", "Somente equipamentoNumero e apelido são aceitos.");
  }
  if (input.equipamentoNumero === undefined) {
    throw new InventoryBaselineError("INVALID_EQUIPMENT", "Número do equipamento é obrigatório.");
  }
  const equipamentoNumero = normalizeInventoryEquipmentNumber(input.equipamentoNumero);
  let apelido = input.apelido;
  if (apelido !== undefined && apelido !== null && typeof apelido !== "string") {
    throw new InventoryBaselineError("INVALID_REQUEST", "Apelido inválido.");
  }
  if (typeof apelido === "string") {
    apelido = apelido.trim();
    if (apelido.length > MAX_APELIDO_LENGTH) throw new InventoryBaselineError("INVALID_REQUEST", "Apelido excede o limite permitido.");
    apelido = apelido || null;
  }
  return { equipamentoNumero, apelido };
}

function storageBaselineFromSnapshot(disks) {
  const capacities = (Array.isArray(disks) ? disks : []).map((disk) => Number(disk.tamanho)).filter((size) => Number.isFinite(size) && size > 0);
  if (!capacities.length) throw new InventoryBaselineError("SNAPSHOT_INSUFFICIENT", "Snapshot técnico sem armazenamento válido.");
  const commercialGb = Math.round(Math.max(...capacities) / 1e9);
  if (!Number.isFinite(commercialGb) || commercialGb <= 0) throw new InventoryBaselineError("SNAPSHOT_INSUFFICIENT", "Snapshot técnico sem armazenamento válido.");
  return `${commercialGb} GB`;
}

function buildTrustedInventoryBaseline(computer) {
  if (!computer || !String(computer.processador || "").trim()) {
    throw new InventoryBaselineError("SNAPSHOT_INSUFFICIENT", "Snapshot técnico sem processador válido.");
  }
  if (!Number.isFinite(Number(computer.ramTotal)) || Number(computer.ramTotal) <= 0) {
    throw new InventoryBaselineError("SNAPSHOT_INSUFFICIENT", "Snapshot técnico sem memória válida.");
  }
  if (!String(computer.sistemaRelease || computer.sistema || "").trim()) {
    throw new InventoryBaselineError("SNAPSHOT_INSUFFICIENT", "Snapshot técnico sem Windows válido.");
  }

  const storage = storageBaselineFromSnapshot(computer.discosFisicos);
  const office = normalizeOfficeInstallations(computer.officeInstallations || []);
  const product = office.products[0] || null;
  const partialKey = product?.primaryLicense?.partialProductKey;

  return {
    processadorEsperado: String(computer.processador).trim(),
    ramEsperada: Number((Number(computer.ramTotal) / (1024 ** 3)).toFixed(1)),
    armazenamentoEsperado: storage,
    windowsEsperado: String(computer.sistemaRelease || computer.sistema).trim(),
    officeEsperado: product?.productName || null,
    officePartialKeyEsperada: OFFICE_PARTIAL_KEY_RE.test(String(partialKey || "")) ? String(partialKey).slice(-5) : null,
    fabricanteModeloEsperado: null,
    observacoes: null
  };
}

async function addInventoryBaseline(value, input, db = prisma, enqueue = enqueueExcelSync) {
  const id = parseComputerId(value);
  const request = normalizeInventoryRequest(input);
  try {
    return await db.$transaction(async (tx) => {
      const computer = await tx.computador.findUnique({
        where: { id },
        include: {
          discosFisicos: true,
          officeInstallations: { where: { isPresent: true }, orderBy: { id: "asc" } },
          inventoryBaseline: true
        }
      });
      if (!computer) throw new InventoryBaselineError("NOT_FOUND", "Computador não encontrado.");
      if (computer.inventoryBaseline) throw new InventoryBaselineError("BASELINE_EXISTS", "Este computador já possui inventário aprovado.");

      const equipmentBaseline = await tx.computerInventoryBaseline.findUnique({ where: { equipamentoNumero: request.equipamentoNumero } });
      if (equipmentBaseline) throw new InventoryBaselineError("DUPLICATE_EQUIPMENT", "Número do equipamento já possui inventário aprovado.");

      const baselineData = buildTrustedInventoryBaseline(computer);
      const apelido = request.apelido === undefined ? computer.apelido || null : request.apelido;
      const updated = await tx.computador.update({ where: { id }, data: { equipamentoNumero: request.equipamentoNumero, apelido } });
      const baseline = await tx.computerInventoryBaseline.create({
        data: {
          computadorId: id,
          equipamentoNumero: request.equipamentoNumero,
          apelidoEsperado: apelido,
          ...baselineData,
          source: "ADMIN_APPROVED_SNAPSHOT"
        }
      });
      const excelSync = await enqueue({ db: tx, computerId: id, baselineId: baseline.id, equipamentoNumero: baseline.equipamentoNumero, snapshot: snapshotFromBaseline(baseline) });
      return {
        computadorId: updated.id,
        equipamentoNumero: updated.equipamentoNumero,
        apelido: updated.apelido,
        baseline: {
          equipamentoNumero: baseline.equipamentoNumero,
          processadorEsperado: baseline.processadorEsperado,
          ramEsperada: baseline.ramEsperada,
          armazenamentoEsperado: baseline.armazenamentoEsperado,
          windowsEsperado: baseline.windowsEsperado,
          officeEsperado: baseline.officeEsperado,
          officePartialKeyEsperada: baseline.officePartialKeyEsperada
        },
        excelSync: { id: excelSync.id, status: excelSync.status }
      };
    });
  } catch (error) {
    if (error instanceof InventoryBaselineError) throw error;
    if (error && error.code === "P2002") throw new InventoryBaselineError("CONFLICT", "Identidade ou inventário já existe.");
    throw error;
  }
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
  createComputadoresService: ({ db = prisma, enqueue = enqueueExcelSync } = {}) => ({ list: () => list(db), getById: (id) => getById(id, db), updateInventoryMetadata: (id, input) => updateInventoryMetadata(id, input, db), getInventoryComparison: (id) => getInventoryComparison(id, db), addInventoryBaseline: (id, input) => addInventoryBaseline(id, input, db, enqueue) }),
  updateInventoryMetadata,
  getCapabilitiesById,
  deleteOfflineComputer,
  ComputerDeletionError,
  InventoryBaselineError,
  buildTrustedInventoryBaseline
};
