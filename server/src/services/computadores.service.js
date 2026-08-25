const prisma = require("../prisma");

async function list() {
  const items = await prisma.computador.findMany({
    orderBy: { hostname: "asc" }
  });

  return items.map((c) => ({
    id: c.id,
    deviceId: c.deviceId,
    hostname: c.hostname,
    usuario: c.usuario,
    ip: c.ip,
    sistema: c.sistema,
    status: c.status,
    ultimaConexao: c.ultimaConexao,
    cpuUso: c.cpuUso,
    ramTotal: c.ramTotal,
    ramUsada: c.ramUsada,
    discoTotal: c.discoTotal,
    discoLivre: c.discoLivre,
    uptime: c.uptime,
    ultimaMetrica: c.ultimaMetrica
  }));
}

module.exports = { list };
