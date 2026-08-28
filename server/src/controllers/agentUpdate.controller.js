const prisma = require("../prisma");
const releasesService = require("../services/releases.service");
const agentServer = require("../ws/agentServer");
const { compareVersion, buildUpdateCommand } = require("../services/updateCommand");

const IN_PROGRESS = [
  "update_pending",
  "update_downloading",
  "update_validating",
  "update_installing"
];

// Versão mínima do Agent que suporta auto-update remoto (preparado para uso futuro).
// Quando definida (ex.: via env MIN_UPDATE_VERSION=1.0.0), agents abaixo dela são rejeitados.
const MIN_UPDATE_VERSION = process.env.MIN_UPDATE_VERSION || null;

async function trigger(req, res) {
  try {
    const id = Number(req.params.id);
    const c = await prisma.computador.findUnique({ where: { id } });
    if (!c) return res.status(404).json({ erro: "Computador nao encontrado." });

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

    const release = await releasesService.getActiveRelease();
    if (!release)
      return res.status(409).json({ erro: "Nenhuma release disponivel no servidor." });
    if (c.status !== "online")
      return res.status(409).json({ erro: "Computador offline." });
    if (c.agentVersion === release.version)
      return res.status(409).json({ erro: "Ja esta na versao mais recente." });

    const st = agentServer.getUpdateState(c.deviceId);
    if (st && IN_PROGRESS.includes(st.status))
      return res.status(409).json({ erro: "Atualizacao ja em andamento." });

    const command = buildUpdateCommand(c.agentVersion, release);
    const ok = agentServer.sendToAgent(c.deviceId, command);
    if (!ok)
      return res.status(409).json({ erro: "Agent nao conectado no momento." });

    agentServer.setUpdateState(c.deviceId, {
      status: "update_pending",
      currentVersion: c.agentVersion,
      version: release.version,
      targetVersion: release.version,
      message: "Solicitacao enviada ao agent.",
      updatedAt: new Date()
    });

    console.log(
      `[Monitor TI] atualizacao solicitada: ${c.hostname} -> ${release.version}`
    );
    return res.status(202).json({ ok: true, version: release.version });
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

async function status(req, res) {
  try {
    const id = Number(req.params.id);
    const c = await prisma.computador.findUnique({ where: { id } });
    if (!c) return res.status(404).json({ erro: "Computador nao encontrado." });
    return res.status(200).json(agentServer.getUpdateState(c.deviceId) || null);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

module.exports = { trigger, status };
