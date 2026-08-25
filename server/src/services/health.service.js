const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function check() {
  // Valida a conexao com o PostgreSQL via Prisma (lanca erro se falhar)
  await prisma.$queryRaw`SELECT 1`;
  return { status: "ok" };
}

module.exports = { check };
