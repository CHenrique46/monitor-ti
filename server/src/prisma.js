const clientPath = process.env.PRISMA_CLIENT_PATH || "@prisma/client";
const { PrismaClient } = require(clientPath);

const prisma = new PrismaClient();

module.exports = prisma;
