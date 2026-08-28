const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeComputersOfflineOnStartup } = require("./src/services/presence.service");

test("normalizeComputersOfflineOnStartup only changes status to offline", async () => {
  const calls = [];
  const mockPrisma = {
    computador: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 2 };
      },
    },
  };

  const logs = [];
  const originalLog = console.log;
  console.log = (msg) => logs.push(msg);

  try {
    const count = await normalizeComputersOfflineOnStartup(mockPrisma);

    assert.equal(count, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      where: {
        status: {
          not: "offline",
        },
      },
      data: {
        status: "offline",
      },
    });
    assert.match(logs[0] || "", /normalized 2 computers to offline on startup/);
  } finally {
    console.log = originalLog;
  }
});
