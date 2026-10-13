const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDiskCleanupAnalyzer, createSafeDiskCleanupExecutor } = require("./src/diskCleanupAnalysis");

async function fixture() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mti-disk-analysis-"));
  const users = path.join(root, "Users");
  const windows = path.join(root, "Windows", "Temp");
  const recycle = path.join(root, "$Recycle.Bin", "S-1-5-21-test");
  await fs.promises.mkdir(path.join(users, "alice", "AppData", "Local", "Temp"), { recursive: true });
  await fs.promises.mkdir(windows, { recursive: true });
  await fs.promises.mkdir(recycle, { recursive: true });
  const now = Date.now();
  const analyze = (overrides = {}) => createDiskCleanupAnalyzer({
    systemDrive: root,
    usersDir: users,
    windowsDir: path.join(root, "Windows"),
      now: () => now,
      timeoutMs: 90000,
      registryDiscovery: false,
      environment: {},
      ...overrides
  });
  return { root, users, windows, recycle, now, analyze };
}

test("arquivos de TEMP com pelo menos 7 dias entram na estimativa", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const target = path.join(f.users, "alice", "AppData", "Local", "Temp", "old.tmp");
  await fs.promises.writeFile(target, Buffer.alloc(12));
  await fs.promises.utimes(target, new Date(f.now - 8 * 86400000), new Date(f.now - 8 * 86400000));
  const result = await f.analyze()();
  assert.equal(result.categories.find((item) => item.id === "USER_TEMP").eligibleBytes, 12);
});

test("arquivos recentes são observados mas não elegíveis", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(f.windows, "new.tmp"), Buffer.alloc(9));
  const result = await f.analyze()();
  const category = result.categories.find((item) => item.id === "WINDOWS_TEMP");
  assert.equal(category.scannedBytes, 9);
  assert.equal(category.eligibleBytes, 0);
});

test("reparse points não são seguidos", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const outside = path.join(f.root, "outside");
  await fs.promises.mkdir(outside);
  await fs.promises.writeFile(path.join(outside, "hidden.tmp"), Buffer.alloc(99));
  await fs.promises.symlink(outside, path.join(f.users, "alice", "AppData", "Local", "Temp", "link"), "junction");
  const result = await f.analyze()();
  const category = result.categories.find((item) => item.id === "USER_TEMP");
  assert.equal(category.scannedBytes, 0);
  assert.ok(category.warnings.includes("reparse_point_skipped"));
});

test("Lixeira conta somente conteúdo $R e não metadados $I", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(f.recycle, "$Iabc"), Buffer.alloc(200));
  await fs.promises.writeFile(path.join(f.recycle, "$Rabc"), Buffer.alloc(17));
  const result = await f.analyze()();
  const category = result.categories.find((item) => item.id === "RECYCLE_BIN");
  assert.equal(category.scannedBytes, 17);
  assert.equal(category.eligibleBytes, 17);
  assert.equal(JSON.stringify(result).includes("$Iabc"), false);
});

test("limite de itens marca análise parcial sem excluir arquivos", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  await fs.promises.writeFile(path.join(f.windows, "one.tmp"), Buffer.alloc(4));
  const result = await f.analyze({ maxItems: 2 })();
  assert.equal(result.actualFreedBytes, null);
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("max_items_reached") || result.warnings.includes("analysis_incomplete"));
  assert.equal(await fs.promises.readFile(path.join(f.windows, "one.tmp"), "utf8"), "\0\0\0\0");
});

test("falha de acesso em uma categoria vira warning sem derrubar resultado", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const originalReaddir = fs.promises.readdir;
  const fsPromises = { ...fs.promises, readdir: async (directory, options) => {
    if (directory === f.windows) {
      const error = new Error("access denied");
      error.code = "EACCES";
      throw error;
    }
    return originalReaddir(directory, options);
  } };
  const result = await f.analyze({ fsPromises })();
  const category = result.categories.find((item) => item.id === "WINDOWS_TEMP");
  assert.equal(category.status, "PARTIAL");
  assert.ok(category.warnings.includes("access_denied"));
  assert.equal(result.analysisOnly, true);
});

test("timeout marca truncation", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const result = await f.analyze({ timeoutMs: 0 })();
  assert.equal(result.truncated, true);
  assert.ok(result.warnings.includes("timeout") || result.warnings.includes("analysis_incomplete"));
});

test("total recuperável é a soma de eligibleBytes", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const old = new Date(f.now - 8 * 86400000);
  const userFile = path.join(f.users, "alice", "AppData", "Local", "Temp", "old.tmp");
  const winFile = path.join(f.windows, "old.tmp");
  await fs.promises.writeFile(userFile, Buffer.alloc(5));
  await fs.promises.writeFile(winFile, Buffer.alloc(7));
  await fs.promises.utimes(userFile, old, old);
  await fs.promises.utimes(winFile, old, old);
  const result = await f.analyze()();
  assert.equal(result.estimatedRecoverableBytes, result.categories.reduce((sum, item) => sum + item.eligibleBytes, 0));
  assert.equal(result.estimatedRecoverableBytes, 12);
});

test("TEMP e TMP configurados localmente entram como OTHER_TEMP", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const temp = path.join(f.root, "configured-temp");
  const tmp = path.join(f.root, "configured-tmp");
  await fs.promises.mkdir(temp);
  await fs.promises.mkdir(tmp);
  const old = new Date(f.now - 8 * 86400000);
  for (const target of [path.join(temp, "a.tmp"), path.join(tmp, "b.tmp")]) {
    await fs.promises.writeFile(target, Buffer.alloc(4));
    await fs.promises.utimes(target, old, old);
  }
  const result = await f.analyze({ environment: { TEMP: temp, TMP: tmp } })();
  const category = result.categories.find((item) => item.id === "OTHER_TEMP");
  assert.equal(category.additionalTempDirectoriesDetected, 2);
  assert.equal(category.eligibleBytes, 8);
  assert.equal(result.estimatedRecoverableBytes, 8);
});

test("caminhos TEMP/TMP iguais são deduplicados", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const temp = path.join(f.root, "same-temp");
  await fs.promises.mkdir(temp);
  const result = await f.analyze({ environment: { TEMP: temp, TMP: temp } })();
  assert.equal(result.categories.find((item) => item.id === "OTHER_TEMP").additionalTempDirectoriesDetected, 1);
});

test("caminhos já cobertos por USER_TEMP e WINDOWS_TEMP não duplicam", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const userTemp = path.join(f.users, "alice", "AppData", "Local", "Temp");
  const result = await f.analyze({ environment: { TEMP: userTemp, TMP: f.windows } })();
  assert.equal(result.categories.find((item) => item.id === "OTHER_TEMP").additionalTempDirectoriesDetected, 0);
});

test("caminhos UNC, relativos e raiz de volume são rejeitados", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const result = await f.analyze({
    environment: { TEMP: "\\\\server\\share", TMP: "relative" },
    machineEnvironment: { TEMP: "C:\\", TMP: "C:\\Windows" }
  })();
  const category = result.categories.find((item) => item.id === "OTHER_TEMP");
  assert.equal(category.additionalTempDirectoriesDetected, 0);
  assert.equal(category.scannedBytes, 0);
});

test("arquivos recentes de OTHER_TEMP são escaneados sem elegibilidade", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const temp = path.join(f.root, "recent-temp");
  await fs.promises.mkdir(temp);
  await fs.promises.writeFile(path.join(temp, "recent.tmp"), Buffer.alloc(9));
  const result = await f.analyze({ environment: { TMP: temp } })();
  const category = result.categories.find((item) => item.id === "OTHER_TEMP");
  assert.equal(category.scannedBytes, 9);
  assert.equal(category.eligibleBytes, 0);
});

test("reparse point configurado em OTHER_TEMP não é seguido", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const target = path.join(f.root, "outside");
  const other = path.join(f.root, "configured-reparse");
  await fs.promises.mkdir(target);
  await fs.promises.writeFile(path.join(target, "hidden.tmp"), Buffer.alloc(99));
  await fs.promises.symlink(target, other, "junction");
  const result = await f.analyze({ environment: { TMP: other } })();
  const category = result.categories.find((item) => item.id === "OTHER_TEMP");
  assert.equal(category.additionalTempDirectoriesDetected, 0);
  assert.ok(category.warnings.includes("reparse_point_skipped"));
});

test("limpeza segura remove apenas arquivos antigos e não inclui Lixeira", async (t) => {
  const f = await fixture();
  t.after(() => fs.promises.rm(f.root, { recursive: true, force: true }));
  const temp = path.join(f.root, "safe-temp");
  await fs.promises.mkdir(temp);
  const old = path.join(temp, "old.tmp");
  const recent = path.join(temp, "recent.tmp");
  await fs.promises.writeFile(old, Buffer.alloc(7));
  await fs.promises.writeFile(recent, Buffer.alloc(11));
  await fs.promises.utimes(old, new Date(f.now - 8 * 86400000), new Date(f.now - 8 * 86400000));
  const result = await createSafeDiskCleanupExecutor({
    systemDrive: f.root,
    usersDir: f.users,
    windowsDir: path.join(f.root, "Windows"),
    environment: { TMP: temp },
    registryDiscovery: false,
    now: () => f.now,
    cleanupBatchSize: 1,
    cleanupYieldMs: 0
  })();
  assert.equal(result.actualFreedBytes, 7);
  assert.equal(result.deletedBytes, 7);
  assert.equal(result.categories.some((item) => item.id === "RECYCLE_BIN"), false);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(result.skippedRecent, 1);
});
