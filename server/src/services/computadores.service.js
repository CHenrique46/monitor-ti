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
    ultimaConexao: c.ultimaConexao
  }));
}

module.exports = { list };
