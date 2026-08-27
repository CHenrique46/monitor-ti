const prisma = require("../prisma");

function mapComputador(c) {
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
    discosFisicos: (c.discosFisicos || []).map((d) => ({
      id: d.id,
      modelo: d.modelo,
      tamanho: d.tamanho,
      interface: d.interface
    }))
  };
}

async function list() {
  const items = await prisma.computador.findMany({
    orderBy: { hostname: "asc" }
  });

  return items.map(mapComputador);
}

async function getById(id) {
  const c = await prisma.computador.findUnique({
    where: { id: Number(id) },
    include: { discosFisicos: true }
  });
  return c ? mapComputador(c) : null;
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

module.exports = { list, getById, getCapabilitiesById };
