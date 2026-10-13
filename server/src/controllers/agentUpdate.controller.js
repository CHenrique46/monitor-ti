const prisma = require("../prisma");
const releasesService = require("../services/releases.service");
const agentServer = require("../ws/agentServer");
const { compareVersion, buildUpdateCommand } = require("../services/updateCommand");
const agentUpdates = require("../services/agentUpdates.service");
const { validatePackageManifest } = require("../services/releases.service");

// Versão mínima do Agent que suporta auto-update remoto (preparado para uso futuro).
// Quando definida (ex.: via env MIN_UPDATE_VERSION=1.0.0), agents abaixo dela são rejeitados.
const MIN_UPDATE_VERSION = process.env.MIN_UPDATE_VERSION || null;

async function hasUsableReleaseArtifact(releases, release, agentVersion) {
  if (!release || !(await releases.hasArtifact(release, agentVersion))) return false;
  if (compareVersion(agentVersion, "1.1.1") < 0) return true;
  if (!release.packageName || !release.packageSha256 || !Number.isInteger(release.packageSize) || release.packageSize <= 0) return false;
  return validatePackageManifest(release);
}

async function trigger(req, res, deps = {}) {
  const db = deps.prisma || prisma;
  const releases = deps.releasesService || releasesService;
  const server = deps.agentServer || agentServer;
  try {
    const id = Number(req.params.id);
    const c = await db.computador.findUnique({ where: { id } });
    if (!c) return res.status(404).json({ erro: "Computador nao encontrado." });
    if (c.arquivadoEm) return res.status(409).json({ erro: "Computador arquivado." });

    if (!c.agentVersion) {
      return res.status(400).json({
        erro: "Agent incompatível com atualização remota. Instale primeiro o baseline compatível."
      });
    }
    if (MIN_UPDATE_VERSION && compareVersion(c.agentVersion, MIN_UPDATE_VERSION) < 0) {
      return res.status(400).json({
        erro: `Agent versão ${c.agentVersion} incompatível com atualização remota (mínimo ${MIN_UPDATE_VERSION}). Instale primeiro o baseline compatível.`
      });
    }

    const requestedVersion = req.body && req.body.version;
    if (requestedVersion !== undefined && typeof requestedVersion !== "string") {
      return res.status(400).json({ erro: "Versao de release invalida." });
    }
    const release = requestedVersion === undefined
      ? await releases.getActiveRelease()
      : await releases.getRelease(requestedVersion.trim());
    if (requestedVersion !== undefined && !release)
      return res.status(404).json({ erro: "Release nao encontrada." });
    if (!release)
      return res.status(409).json({ erro: "Nenhuma release disponivel no servidor." });
    if (c.status !== "online")
      return res.status(409).json({ erro: "Computador offline." });
    const versionComparison = compareVersion(c.agentVersion, release.version);
    if (versionComparison === null)
      return res.status(409).json({ erro: "Versao atual ou destino invalida." });
    if (versionComparison >= 0)
      return res.status(409).json({ erro: versionComparison === 0 ? "Ja esta na versao mais recente." : "Downgrade de Agent nao permitido." });

    if (!(await hasUsableReleaseArtifact(releases, release, c.agentVersion)))
      return res.status(409).json({ erro: "Release registrada, mas artefato fisico indisponivel." });

    const created = await agentUpdates.createPending(db, {
      computadorId: c.id,
      deviceId: c.deviceId,
      hostname: c.hostname,
      versaoAnterior: c.agentVersion,
      versaoDestino: release.version,
      iniciadoPor: req.humanUser && req.humanUser.username,
      releaseId: release.id
    });
    if (!created.ok) return res.status(409).json({ erro: "UPDATE_ALREADY_IN_PROGRESS" });

    const command = buildUpdateCommand(c.agentVersion, release);
    const ok = server.sendToAgent(c.deviceId, command);
    if (!ok) {
      await db.agentUpdate.update({ where: { id: created.update.id }, data: { status: "FAILED", erro: "Agent nao conectado no momento.", finalizadoEm: new Date() } });
      return res.status(409).json({ erro: "Agent nao conectado no momento." });
    }

    console.log(
      `[Monitor TI] atualizacao solicitada: ${c.hostname} -> ${release.version} (releaseId=${release.id})`
    );
    return res.status(202).json({ ok: true, version: release.version });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

async function status(req, res, deps = {}) {
  const db = deps.prisma || prisma;
  try {
    const id = Number(req.params.id);
    const c = await db.computador.findUnique({ where: { id } });
    if (!c) return res.status(404).json({ erro: "Computador nao encontrado." });
    const update = await agentUpdates.latest(db, c.id);
    return res.status(200).json(agentUpdates.toPublic(update));
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

module.exports = { trigger, status };
