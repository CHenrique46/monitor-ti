const prisma = require("../prisma");

async function normalizeComputersOfflineOnStartup(client = prisma) {
  const result = await client.computador.updateMany({
    where: {
      status: {
        not: "offline",
      },
    },
    data: {
      status: "offline",
    },
  });

  const count = result?.count || 0;
  console.log(`[presence] normalized ${count} computers to offline on startup`);
  return count;
}

module.exports = {
  normalizeComputersOfflineOnStartup,
};
