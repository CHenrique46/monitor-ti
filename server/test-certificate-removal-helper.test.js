const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const {
  HELPER_TIMEOUT_MS,
  HELPER_PATH,
  POWERSHELL_PATH,
  createCertificateRemovalHelper,
  validateRequest,
  validatePowerShellPath
} = require("./src/services/certificateRemovalHelper.service");

const REQUEST = { operation: "inspect", destinationRoot: "\\\\server\\share", filename: "certificate-1.pfx", expectedFingerprint: "a".repeat(64) };

function childMock({ stdout = "{\"ok\":true,\"result\":\"ABSENT\",\"code\":\"\"}", close = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: (input) => { child.input = input; if (close) setImmediate(() => { child.stdout.emit("data", Buffer.from(stdout)); child.emit("close", 0); }); } };
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; return true; };
  return child;
}

test("helper valida protocolo estruturado e rejeita caminhos inseguros", () => {
  assert.deepEqual(validateRequest(REQUEST), REQUEST);
  for (const filename of ["..\\outside.pfx", "file.txt", "file.pfx:ads", "*.pfx", "folder\\file.pfx"]) {
    assert.throws(() => validateRequest({ ...REQUEST, filename }), { code: "HELPER_INPUT_INVALID" });
  }
  assert.throws(() => validateRequest({ ...REQUEST, destinationRoot: "https://server/share" }), { code: "HELPER_INPUT_INVALID" });
  assert.throws(() => validateRequest({ ...REQUEST, expectedFingerprint: "bad" }), { code: "HELPER_INPUT_INVALID" });
});

test("helper usa PowerShell absoluto, sem shell, sem senha e limita a entrada", async () => {
  const child = childMock();
  let command;
  const helper = createCertificateRemovalHelper({ spawnProcess: (file, args, options) => { command = { file, args, options }; return child; } });
  const result = await helper.run(REQUEST);
  assert.equal(result.result, "ABSENT");
  assert.equal(command.file, POWERSHELL_PATH);
  assert.equal(path.basename(command.file).toLowerCase(), "powershell.exe");
  assert.equal(command.options.shell, false);
  assert.ok(command.args.includes("-File"));
  assert.ok(!command.args.some((arg) => /password|senha|secret|credential/i.test(arg)));
  assert.doesNotMatch(child.input, /password|senha|secret/i);
  assert.ok(fs.existsSync(HELPER_PATH));
  assert.equal(HELPER_TIMEOUT_MS, 120000);
  assert.doesNotThrow(validatePowerShellPath);
});

test("helper sanitiza saída inválida/excessiva, stderr e exit code", async () => {
  const invalid = childMock({ stdout: "not-json" });
  const helper = createCertificateRemovalHelper({ spawnProcess: () => invalid });
  assert.equal((await helper.run(REQUEST)).code, "HELPER_OUTPUT_INVALID");

  const noisy = childMock({ stdout: "x".repeat(5000) });
  const noisyHelper = createCertificateRemovalHelper({ spawnProcess: () => noisy });
  assert.equal((await noisyHelper.run(REQUEST)).code, "HELPER_OUTPUT_LIMIT");

  const failed = childMock({ close: false });
  const failedHelper = createCertificateRemovalHelper({ spawnProcess: () => failed, timeoutMs: 20, killWaitMs: 5 });
  const timeout = await failedHelper.run(REQUEST);
  assert.equal(timeout.code, "HELPER_TIMEOUT");
  assert.ok(failed.killCalls >= 1);
});

test("helper aceita presença válida e rejeita schema de saída aberto", async () => {
  const present = childMock({ stdout: '{"ok":true,"result":"PRESENT","code":""}' });
  const helper = createCertificateRemovalHelper({ spawnProcess: () => present });
  assert.deepEqual(await helper.run({ ...REQUEST, operation: "inspect_presence", expectedFingerprint: "" }), { ok: true, result: "PRESENT", code: null });
  const extra = childMock({ stdout: '{"ok":true,"result":"ABSENT","code":"","secret":"x"}' });
  const extraHelper = createCertificateRemovalHelper({ spawnProcess: () => extra });
  assert.equal((await extraHelper.run(REQUEST)).code, "HELPER_OUTPUT_INVALID");
});

test("timeout reenvia encerramento para filho que ignora o primeiro término", async () => {
  const child = childMock({ close: false });
  const helper = createCertificateRemovalHelper({ spawnProcess: () => child, timeoutMs: 10, killWaitMs: 5 });
  assert.equal((await helper.run(REQUEST)).code, "HELPER_TIMEOUT");
  assert.ok(child.killCalls >= 2);
  assert.equal(helper.activeCount(), 0);
});

test("shutdown impede novo helper e encerra o filho ativo", async () => {
  const child = childMock({ close: false });
  const helper = createCertificateRemovalHelper({ spawnProcess: () => child, timeoutMs: 5000, killWaitMs: 5 });
  const running = helper.run(REQUEST);
  helper.stop();
  assert.equal(helper.activeCount(), 1);
  assert.ok(child.killCalls >= 1);
  assert.equal((await helper.run(REQUEST)).code, "HELPER_SHUTTING_DOWN");
  child.emit("close", 1);
  assert.equal((await running).code, "HELPER_EXIT_FAILED");
});

test("PowerShell helper não expõe chamadas globais de término", () => {
  const source = fs.readFileSync(HELPER_PATH, "utf8");
  assert.doesNotMatch(source, /taskkill|Stop-Process/i);
  assert.match(source, /Resolve-Path/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /Remove-Item -LiteralPath/);
});

test("canonicaliza├º├úo usa ProviderPath para raiz e alvo", () => {
  const source = fs.readFileSync(HELPER_PATH, "utf8");
  assert.match(source, /function Remove-KnownProviderPrefix/);
  assert.match(source, /function Normalize-CanonicalPath/);
  assert.match(source, /function Get-CanonicalExisting/);
  assert.match(source, /function Test-Within/);
  assert.match(source, /Resolve-Path -LiteralPath \$item\.FullName/);
  assert.match(source, /Normalize-CanonicalPath \$resolved\.ProviderPath/);
  assert.doesNotMatch(source, /\$real\.StartsWith\(\$prefix/);
  assert.match(source, /OrdinalIgnoreCase/);
});

test("canonicaliza├º├úo preserva as rejei├º├Áes de basename e containment", () => {
  const source = fs.readFileSync(HELPER_PATH, "utf8");
  for (const expression of [
    "TARGET_INVALID",
    "TEMP_TARGET_INVALID",
    "TARGET_UNSAFE",
    "TARGET_OUTSIDE_ROOT",
    "PROVIDER_INVALID",
    "\\.\\.",
    "[\\\\/:*?\"<>|]",
    "Get-CanonicalTarget $root $filename",
    "Get-CanonicalTarget $Root $Filename $true"
  ]) assert.ok(source.includes(expression), `missing source expression: ${expression}`);
  assert.match(source, /StartsWith\(\$rootValue/);
});

test("regress├úo antiga exige formato can├┤nico ├║nico e n├úo mistura Path com ProviderPath", () => {
  const source = fs.readFileSync(HELPER_PATH, "utf8");
  assert.match(source, /Microsoft\\.PowerShell\\.Core\\\\FileSystem/);
  assert.match(source, /FileSystem\)::/);
  assert.match(source, /ProviderPath/);
  assert.match(source, /GetFullPath\(\$raw\)/);
  assert.match(source, /Get-CanonicalExisting \$item\.FullName/);
  assert.match(source, /return Get-CanonicalExisting \$item\.FullName "ROOT_INVALID"/);
  assert.match(source, /target = Normalize-CanonicalPath \$targetInput "TARGET_INVALID"/);
});
