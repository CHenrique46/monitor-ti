const prisma = require("../prisma");
const agentServer = require("../ws/agentServer");
const remoteActionsServiceModule = require("../services/remoteActions.service");
const wallpaperAsset = require("../services/wallpaperAsset.service");
const { getAgentServerPublicUrl } = require("../config");

function createRemoteActionsController({ prisma: db = prisma, agentServer: ws = agentServer, remoteActionsService = remoteActionsServiceModule, wallpaperAssetService = wallpaperAsset } = {}) {
async function setWallpaper(req, res) {
  try {
    const baseUrl = getAgentServerPublicUrl();
    const computadorId = Number(req.params.id);
    const computador = await db.computador.findUnique({ where: { id: computadorId }, select: { id: true, deviceId: true, hostname: true, status: true } });
    if (!computador) return res.status(404).json({ erro: "Computador nao encontrado." });
    wallpaperAssetService.validate();
    const execution = await remoteActionsService.createExecution({ computadorId: computador.id, action: "set_wallpaper" });
    if (computador.status !== "online") {
      await remoteActionsService.markRejected(execution.actionExecutionId, "Computador offline.", "Computador offline.");
      return res.status(409).json({ erro: "Computador offline.", execution: await remoteActionsService.getByActionExecutionId(execution.actionExecutionId) });
    }
    const issued = wallpaperAssetService.issueDownloadToken({ actionExecutionId: execution.actionExecutionId, deviceId: computador.deviceId });
    const downloadUrl = `${baseUrl}/api/assets/wallpaper/current?token=${encodeURIComponent(issued.token)}&actionExecutionId=${encodeURIComponent(execution.actionExecutionId)}&assetId=${encodeURIComponent(issued.asset.assetId)}`;
    const ok = ws.sendToAgent(computador.deviceId, { type: "remote_action", protocolVersion: 1, deviceId: computador.deviceId, actionExecutionId: execution.actionExecutionId, action: "set_wallpaper", payload: { actionExecutionId: execution.actionExecutionId, assetId: issued.asset.assetId, downloadUrl, expectedSha256: issued.asset.sha256, expectedSize: issued.asset.size, extension: issued.asset.extension } });
    if (!ok) {
      await remoteActionsService.markRejected(execution.actionExecutionId, "Agent nao conectado no momento.", "Agent nao conectado no momento.");
      return res.status(409).json({ erro: "Agent nao conectado no momento.", execution: await remoteActionsService.getByActionExecutionId(execution.actionExecutionId) });
    }
    await remoteActionsService.markDispatched(execution.actionExecutionId);
    return res.status(202).json({ ok: true, execution: await remoteActionsService.getByActionExecutionId(execution.actionExecutionId) });
  } catch (err) {
    if (err && err.code === "AGENT_SERVER_PUBLIC_URL_INVALID") return res.status(503).json({ erro: "Download do Agent não está configurado." });
    return res.status(400).json({ erro: err.message });
  }
}
async function spoolerReset(req, res) {
  try {
    const computadorId = Number(req.params.id);
    const computador = await db.computador.findUnique({
      where: { id: computadorId },
      select: { id: true, deviceId: true, hostname: true, status: true }
    });
    if (!computador) {
      return res.status(404).json({ erro: "Computador nao encontrado." });
    }

    const execution = await remoteActionsService.createExecution({
      computadorId: computador.id,
      action: "spooler_reset"
    });

    if (computador.status !== "online") {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Computador offline.",
        "Computador offline."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({
        erro: "Computador offline.",
        execution: finalExecution
      });
    }

    const ok = ws.sendToAgent(computador.deviceId, {
      type: "remote_action",
      protocolVersion: 1,
      deviceId: computador.deviceId,
      actionExecutionId: execution.actionExecutionId,
      action: execution.action,
      payload: {}
    });

    if (!ok) {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Agent nao conectado no momento.",
        "Agent nao conectado no momento."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({
        erro: "Agent nao conectado no momento.",
        execution: finalExecution
      });
    }

    await remoteActionsService.markDispatched(execution.actionExecutionId);
    const dispatched = await remoteActionsService.getByActionExecutionId(execution.actionExecutionId);
    console.log(
      `[Monitor TI] acao remota solicitada: ${computador.hostname} -> ${execution.actionExecutionId}`
    );
    return res.status(202).json({ ok: true, execution: dispatched });
  } catch (err) {
    return res.status(400).json({ erro: err.message });
  }
}

async function serviceRestart(req, res) {
  try {
    const computadorId = Number(req.params.id);
    const serviceKey = String(req.body && req.body.serviceKey || "").trim().toLowerCase();
    if (!remoteActionsServiceModule.SERVICE_ALLOWLIST[serviceKey]) {
      return res.status(400).json({ erro: "Serviço não permitido." });
    }

    const computador = await db.computador.findUnique({
      where: { id: computadorId },
      select: { id: true, deviceId: true, hostname: true, status: true }
    });
    if (!computador) {
      return res.status(404).json({ erro: "Computador nao encontrado." });
    }

    const execution = await remoteActionsService.createExecution({
      computadorId: computador.id,
      action: "service_restart",
      payload: { serviceKey }
    });

    if (computador.status !== "online") {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Computador offline.",
        "Computador offline."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({ erro: "Computador offline.", execution: finalExecution });
    }

    const ok = ws.sendToAgent(computador.deviceId, {
      type: "remote_action",
      protocolVersion: 1,
      deviceId: computador.deviceId,
      actionExecutionId: execution.actionExecutionId,
      action: execution.action,
      payload: execution.payload
    });
    if (!ok) {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Agent nao conectado no momento.",
        "Agent nao conectado no momento."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({
        erro: "Agent nao conectado no momento.",
        execution: finalExecution
      });
    }

    await remoteActionsService.markDispatched(execution.actionExecutionId);
    const dispatched = await remoteActionsService.getByActionExecutionId(execution.actionExecutionId);
    console.log(
      `[Monitor TI] service_restart solicitado: ${computador.hostname} -> ${execution.actionExecutionId}`
    );
    return res.status(202).json({ ok: true, execution: dispatched });
  } catch (err) {
    return res.status(400).json({ erro: err.message });
  }
}

async function systemMaintenance(req, res) {
  try {
    const computadorId = Number(req.params.id);
    const computador = await db.computador.findUnique({
      where: { id: computadorId },
      select: { id: true, deviceId: true, hostname: true, status: true }
    });
    if (!computador) {
      return res.status(404).json({ erro: "Computador nao encontrado." });
    }

    const execution = await remoteActionsService.createExecution({
      computadorId: computador.id,
      action: "system_maintenance"
    });

    if (computador.status !== "online") {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Computador offline.",
        "Computador offline."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({ erro: "Computador offline.", execution: finalExecution });
    }

    const ok = ws.sendToAgent(computador.deviceId, {
      type: "remote_action",
      protocolVersion: 1,
      deviceId: computador.deviceId,
      actionExecutionId: execution.actionExecutionId,
      action: execution.action,
      payload: {}
    });
    if (!ok) {
      await remoteActionsService.markRejected(
        execution.actionExecutionId,
        "Agent nao conectado no momento.",
        "Agent nao conectado no momento."
      );
      const finalExecution = await remoteActionsService.getByActionExecutionId(
        execution.actionExecutionId
      );
      return res.status(409).json({
        erro: "Agent nao conectado no momento.",
        execution: finalExecution
      });
    }

    await remoteActionsService.markDispatched(execution.actionExecutionId);
    const dispatched = await remoteActionsService.getByActionExecutionId(execution.actionExecutionId);
    console.log(
      `[Monitor TI] system_maintenance solicitado: ${computador.hostname} -> ${execution.actionExecutionId}`
    );
    return res.status(202).json({ ok: true, execution: dispatched });
  } catch (err) {
    return res.status(400).json({ erro: err.message });
  }
}

async function list(req, res) {
  try {
    const computadorId = Number(req.params.id);
    const computador = await db.computador.findUnique({
      where: { id: computadorId },
      select: { id: true }
    });
    if (!computador) {
      return res.status(404).json({ erro: "Computador nao encontrado." });
    }

    const items = await remoteActionsService.listByComputador(computador.id, req.query.take);
    return res.status(200).json(items);
  } catch (err) {
    return res.status(500).json({ erro: err.message });
  }
}

  return {
    spoolerReset,
    serviceRestart,
    systemMaintenance,
    setWallpaper,
    list
  };
}

module.exports = {
  ...createRemoteActionsController(),
  createRemoteActionsController
};
