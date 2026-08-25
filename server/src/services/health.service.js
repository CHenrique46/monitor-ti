const prisma = require("../prisma");

async function check() {
  // Valida a conexao com o PostgreSQL via Prisma (lanca erro se falhar)
  await prisma.$queryRaw`SELECT 1`;
  return { status: "ok" };
}

module.exports = { check };
