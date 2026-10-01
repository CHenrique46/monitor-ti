// Registra uma nova release (multi-arquivo) do Agent no servidor.
// Uso: node scripts/register-agent-release.js <versao> <agentExe> [<notifierExe>] [--agent-only] [--activate]
//
// Para releases 1.0.x (legadas, arquivo único) informe o mesmo exe duas vezes,
// ou use o formato antigo: <versao> <exe> [--activate] (sem notifier).
//
// - Calcula SHA-256 e tamanho do Agent e do Notifier.
// - Copia ambos para releases/agent/<versao>/.
// - Gera manifest.json (lista de arquivos + hashes) e o pacote .zip.
// - Grava release.json (sem segredos).
// - Insere/atualiza o registro AgentRelease no banco.
//   IMPORTANTE: por padrão a release fica INA TIVA (active=false). Só ativa
//   se --activate for informado. Nunca ative sem aprovação explícita.
require("dotenv").config({
  path: require("path").join(__dirname, "..", "server", ".env")
});
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { persistReleaseRecord } = require("../server/src/services/agentReleaseRegistration.service");
const prisma = new PrismaClient();

const RELEASES_ROOT = path.join(__dirname, "..", "releases", "agent");
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const AGENT_NAME = "MonitorTI-Agent.exe";
const NOTIFIER_NAME = "MonitorTI-Notifier.exe";
const INTEGRITY_NAME = "notifier-integrity.json";

function sha256Of(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function buildZip(dir, version, packageMode) {
  const zipName = "MonitorTI-Agent-" + version + ".zip";
  const zipPath = path.join(dir, zipName);
  const entries = packageMode === "agent-only"
    ? [AGENT_NAME, "manifest.json"]
    : [AGENT_NAME, NOTIFIER_NAME, "manifest.json", INTEGRITY_NAME];
  const r = spawnSync(
    "tar",
    ["-a", "-cf", zipPath, "-C", dir, ...entries],
    { windowsHide: true }
  );
  if (r.status !== 0) {
    throw new Error("Falha ao criar pacote zip (tar " + r.status + "): " + (r.stderr || "").toString());
  }
  const buf = fs.readFileSync(zipPath);
  return { zipName, zipSha256: sha256Of(buf), zipSize: buf.length };
}


async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const version = positional[0];
  const agentExe = positional[1];
  const agentOnly = args.includes("--agent-only");
  const notifierExe = agentOnly ? null : positional[2];
  const activate = args.includes("--activate");

  if (!version || !agentExe) {
    console.error("Uso: node scripts/register-agent-release.js <versao> <agentExe> [<notifierExe>] [--agent-only] [--activate]");
    process.exit(1);
  }
  if (!VERSION_RE.test(version)) {
    console.error("Versao invalida. Use o formato x.y.z (ex.: 1.1.0).");
    process.exit(1);
  }
  if (!fs.existsSync(agentExe)) {
    console.error("Agent nao encontrado: " + agentExe);
    process.exit(1);
  }
  if (agentOnly && positional[2]) {
    console.error("Nao informe Notifier em uma release --agent-only.");
    process.exit(1);
  }
  if (notifierExe && !fs.existsSync(notifierExe)) {
    console.error("Notifier nao encontrado: " + notifierExe);
    process.exit(1);
  }

  // Agent (arquivo único legado + parte do pacote).
  const agentBuf = fs.readFileSync(agentExe);
  const agentSha256 = sha256Of(agentBuf);
  const agentSize = agentBuf.length;

  const dir = path.join(RELEASES_ROOT, version);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new Error("Diretorio de release ja existe e nao esta vazio: " + dir);
  }
  fs.mkdirSync(dir, { recursive: true });
  const destAgent = path.join(dir, AGENT_NAME);
  fs.copyFileSync(agentExe, destAgent);
  console.log("Agent:    SHA " + agentSha256);
  console.log("          size " + agentSize);

  if (notifierExe || agentOnly) {
    const packageMode = agentOnly ? "agent-only" : "full";
    const files = [{ name: AGENT_NAME, sha256: agentSha256, size: agentSize }];
    if (!agentOnly) {
      const notBuf = fs.readFileSync(notifierExe);
      const notSha256 = sha256Of(notBuf);
      const notSize = notBuf.length;
      const destNot = path.join(dir, NOTIFIER_NAME);
      fs.copyFileSync(notifierExe, destNot);
      files.push({ name: NOTIFIER_NAME, sha256: notSha256, size: notSize });
      console.log("Notifier: SHA " + notSha256);
      console.log("          size " + notSize);
      const integrity = Buffer.from(JSON.stringify({ version, notifierSha256: notSha256, notifierSize: notSize }, null, 2));
      fs.writeFileSync(path.join(dir, INTEGRITY_NAME), integrity);
      files.push({ name: INTEGRITY_NAME, sha256: sha256Of(integrity), size: integrity.length });
    }
    const manifest = { schemaVersion: 1, version, packageMode, files };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    console.log("Manifest gravado.");

    const { zipName, zipSha256, zipSize } = buildZip(dir, version, packageMode);
    console.log("Pacote:   " + zipName + "  SHA " + zipSha256 + "  size " + zipSize);
    fs.writeFileSync(
      path.join(dir, "release.json"),
      JSON.stringify(
        { version, file: AGENT_NAME, sha256: agentSha256, size: agentSize, zip: zipName, zipSha256, zipSize, manifest },
        null,
        2
      )
    );
    console.log("Arquivos copiados para " + dir);

    await persistReleaseRecord(prisma, {
      version,
      activate,
      create: { version, fileName: AGENT_NAME, sha256: agentSha256, size: agentSize, packageName: zipName, packageSha256: zipSha256, packageSize: zipSize, manifest, active: activate },
      update: { fileName: AGENT_NAME, sha256: agentSha256, size: agentSize, packageName: zipName, packageSha256: zipSha256, packageSize: zipSize, manifest, active: activate }
    });
  } else {
    // Release legada (1.0.x): somente Agent.
    fs.writeFileSync(
      path.join(dir, "release.json"),
      JSON.stringify({ version, file: AGENT_NAME, sha256: agentSha256, size: agentSize }, null, 2)
    );
    console.log("Release legada (somente Agent) em " + dir);
    await persistReleaseRecord(prisma, {
      version,
      activate,
      create: { version, fileName: AGENT_NAME, sha256: agentSha256, size: agentSize, active: activate },
      update: { fileName: AGENT_NAME, sha256: agentSha256, size: agentSize, active: activate }
    });
  }

  console.log("Release " + version + " registrada" + (activate ? " e ATIVADA." : " (INATIVA)."));
  await prisma.$disconnect();
}

if (require.main === module) main().catch(async (e) => {
  console.error("Erro ao registrar release:", e.message);
  try { await prisma.$disconnect(); } catch (x) {}
  process.exit(1);
});

module.exports = { buildZip };
