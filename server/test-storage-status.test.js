const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkStorageAccess } = require("./src/services/certificados.service");

test("checkStorageAccess valida diretório fictício e sanitiza erros", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mti-storage-status-"));
  const missingPath = path.join(root, "fictional-secret-share");
  try {
    const valid = await checkStorageAccess({ configuredPath: root });
    assert.deepEqual(valid, {
      configurationPresent: true,
      pathRecognized: true,
      pathReachable: true,
      isDirectory: true,
      readAccess: true,
      errorCode: null
    });

    const invalid = await checkStorageAccess({ configuredPath: "relative\\storage" });
    assert.equal(invalid.errorCode, "CONFIG_PATH_INVALID");
    assert.equal(invalid.pathRecognized, false);

    const missing = await checkStorageAccess({ configuredPath: missingPath });
    assert.equal(missing.errorCode, "ENOENT");
    assert.equal(JSON.stringify(missing).includes(missingPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
