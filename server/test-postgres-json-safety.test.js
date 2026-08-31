const test = require("node:test");
const assert = require("node:assert/strict");

const prisma = require("./src/prisma");
const { sanitizeJsonValue } = require("./src/services/remoteActions.service");

test("PostgreSQL aceita resultado sanitizado sem alterar dados persistidos", async () => {
  const cases = [
    ["nul", "abc\u0000def"],
    ["isolated-high", "abc\uD800def"],
    ["isolated-low", "abc\uDC00def"],
    ["control", "abc\u0001\u0008\u000B\u000C\u001F\u007Fdef"],
    ["noncharacters", "abc\uFFFE\uFFFFdef"],
    ["pair", "abc\uD83D\uDE00def"],
    ["emoji", "😀"],
    ["portuguese", "Manutenção concluída"]
  ];

  try {
    for (const [name, value] of cases) {
      const sanitizedJson = JSON.stringify(sanitizeJsonValue({ value }));
      try {
        await prisma.$queryRawUnsafe("SELECT $1::jsonb", sanitizedJson);
      } catch (error) {
        assert.fail(`${name} falhou no PostgreSQL: ${error.code || error.name}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
});
