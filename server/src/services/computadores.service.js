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
    status: c.status,
    ultimaConexao: c.ultimaConexao,
    cpuUso: c.cpuUso,
    ramTotal: c.ramTotal,
    ramUsada: c.ramUsada,
    discoTotal: c.discoTotal,
    discoLivre: c.discoLivre,
    uptime: c.uptime,
    ultimaMetrica: c.ultimaMetrica
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
    where: { id: Number(id) }
  });
  return c ? mapComputador(c) : null;
}

module.exports = { list, getById };
