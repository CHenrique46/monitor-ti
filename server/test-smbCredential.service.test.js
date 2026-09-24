const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const service = require("./src/services/smbCredential.service");
const config = require("./src/config");

const IDENTITY = "EXAMPLE\\MonitorTIService";

function setEnv(values) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeFileSystem({ exists = true } = {}) {
  return {
    lstatSync() {
      if (!exists) throw new Error("not found");
      return { isFile: () => true, isSymbolicLink: () => false };
    }
  };
}

function validPath() {
  return "C:\\ProgramData\\MonitorTI\\secrets\\certificados-smb.dpapi";
}

function fakeSpawn(output = "SMB_RESULT=OK\n") {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: { on: (event, handler) => { if (event === "data") handler(Buffer.from(output)); } },
      on: (event, handler) => { if (event === "close") setImmediate(() => handler(0)); }
    };
  };
  return { calls, spawnProcess };
}

async function runWithConfig({ secretPath = validPath(), identity = IDENTITY, output } = {}) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "smb-hardening-test-"));
  const effectiveSecretPath = secretPath === validPath() ? path.join(temporaryRoot, "certificados-smb.dpapi") : secretPath;
  if (effectiveSecretPath) fs.writeFileSync(effectiveSecretPath, "test-only");
  const restore = setEnv({
    CERTIFICATE_SMB_CREDENTIAL_FILE: effectiveSecretPath,
    CERTIFICATE_SMB_EXPECTED_SERVICE_IDENTITY: identity
  });
  try {
    const fake = fakeSpawn(output);
    const result = await service.createDefaultRunner({ spawnProcess: fake.spawnProcess })("connect");
    return { result, calls: fake.calls };
  } finally {
    restore();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

test("import nao inicia runner nem conexao", () => {
  assert.equal(typeof service.createSmbCredentialConnection, "function");
  assert.equal(typeof service.createDefaultRunner, "function");
});

test("configuracao ausente falha fechado sem iniciar PowerShell", async () => {
  const result = await runWithConfig({ secretPath: "" });
  assert.deepEqual(result.result, { ok: false, code: "SMB_SECRET_PATH_INVALID" });
  assert.equal(result.calls.length, 0);
});

test("caminho relativo, traversal e arquivo inesperado sao rejeitados", () => {
  for (const value of ["secrets\\certificados-smb.dpapi", "C:\\safe\\..\\secret\\certificados-smb.dpapi", "C:\\safe\\credential.txt"]) {
    assert.throws(() => config.validateSmbSecretPath(value, fakeFileSystem()), { code: /SMB_SECRET_/ });
  }
});

test("arquivo inexistente falha com erro sanitizado", () => {
  assert.throws(() => config.validateSmbSecretPath(validPath(), fakeFileSystem({ exists: false })), { code: "SMB_SECRET_FILE_UNAVAILABLE" });
});

test("identidade ausente falha fechado", async () => {
  const result = await runWithConfig({ identity: "" });
  assert.deepEqual(result.result, { ok: false, code: "SMB_IDENTITY_INVALID" });
  assert.equal(result.calls.length, 0);
});

test("identidade diferente e identidade normalizada sao tratadas sem segredo", () => {
  assert.equal(config.smbIdentitiesEqual("EXAMPLE\\OtherService", IDENTITY), false);
  assert.equal(config.smbIdentitiesEqual(" example/monitortiservice ", IDENTITY), true);
});

test("runner envia somente caminho, identidade e raizes nao secretas", async () => {
  const result = await runWithConfig();
  assert.deepEqual(result.result, { ok: true, code: null });
  assert.equal(result.calls.length, 1);
  const args = result.calls[0].args;
  assert.equal(args.includes("-SecretPath"), true);
  assert.equal(args.includes("-ExpectedIdentity"), true);
  assert.equal(args.some((value) => /password|secret-value|credential-value/i.test(value)), false);
});

test("saida malformada e erro nao vazam valores sensiveis", async () => {
  const result = await runWithConfig({ output: "SMB_RESULT=ERROR\nSMB_CODE=secret-value\n" });
  assert.deepEqual(result.result, { ok: false, code: "SMB_HELPER_FAILED" });
  assert.equal(JSON.stringify(result.result).match(/secret-value|password|EXAMPLE|certificados-smb/i), null);
});

test("fluxo valido preserva connect e disconnect", async () => {
  const calls = [];
  const connection = service.createSmbCredentialConnection({ runner: async (operation) => { calls.push(operation); return { ok: true, code: null }; } });
  assert.equal((await connection.connect()).ok, true);
  assert.equal(connection.ownsConnection(), true);
  assert.equal((await connection.disconnect()).ok, true);
  assert.deepEqual(calls, ["connect", "disconnect"]);
});

test("nenhuma chamada SMB ou DPAPI real e necessaria nos testes", () => {
  const source = fs.readFileSync(service.HELPER_PATH, "utf8");
  assert.match(source, /WNetAddConnection2W/);
  assert.match(source, /ProtectedData\]::Unprotect/);
  assert.equal(typeof os.tmpdir(), "string");
  assert.equal(path.isAbsolute(path.join(os.tmpdir(), "fake")), true);
});
