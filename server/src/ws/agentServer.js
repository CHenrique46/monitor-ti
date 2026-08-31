const { WebSocketServer } = require("ws");
const prisma = require("../prisma");
const historicoService = require("../services/historico.service");
const alertasService = require("../services/alertas.service");
const avisosService = require("../services/avisos.service");
const remoteActionsService = require("../services/remoteActions.service");
const logger = require("../logger");

const HEARTBEAT_INTERVAL = 30000;

function summarizeReconciliationError(error) {
  const stack = String(error && error.stack || "")
    .split("\n")
    .slice(0, 3)
    .join(" | ")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 600);
  return {
    name: String(error && error.name || "Error"),
    message: String(error && error.message || error || "Erro desconhecido").replace(/[\r\n]+/g, " ").slice(0, 400),
    stack: stack || "-"
  };
}

// Estados de atualização por deviceId (em memória)
const updateStates = new Map();

// Capacidades reportadas pelo Agent (ex.: "notices"). Em memória: é
// reenviado no register e atualizado quando o Agent informa prontidão
// (ex.: Notifier instalado). Evita despachar notice_show para agents
// que não conseguem exibir avisos.
const agentCaps = new Map();
let wssRef = null;

function setCapabilities(deviceId, caps) {
  if (!deviceId) return;
  agentCaps.set(deviceId, new Set(Array.isArray(caps) ? caps : []));
}

function applyRegisterCapabilities(deviceId, caps) {
  if (!deviceId) return;
  if (Array.isArray(caps) && caps.length > 0) {
    setCapabilities(deviceId, caps);
  }
}

function clearCapabilities(deviceId) {
  if (!deviceId) return;
  agentCaps.delete(deviceId);
}

function getCapabilities(deviceId) {
  const s = agentCaps.get(deviceId);
  return s ? Array.from(s) : [];
}

// Só despacha avisos para Agents que reportaram a capacidade "notices".
// Isso impede o servidor de considerar o Agent pronto para avisos apenas
// por agentVersion===1.1.0; o Notifier precisa estar realmente instalado.
function hasCapability(deviceId, cap) {
  const s = agentCaps.get(deviceId);
  return !!s && s.has(cap);
}

function getUpdateState(deviceId) {
  return updateStates.get(deviceId) || null;
}

function setUpdateState(deviceId, state) {
  updateStates.set(deviceId, state);
}

function clearUpdateState(deviceId) {
  updateStates.delete(deviceId);
}

function resetUpdateStatesForTests() {
  updateStates.clear();
}

function applyUpdateStatusMessage(msg) {
  if (!msg || !msg.deviceId) return null;
  const prev = updateStates.get(msg.deviceId) || {};
  const isFailed = msg.status === "update_failed";
  const state = {
    ...prev,
    status: msg.status,
    version: msg.version || prev.version || null,
    targetVersion: msg.targetVersion || prev.targetVersion || msg.version || null,
    currentVersion: msg.currentVersion || prev.currentVersion || null,
    stage: msg.stage || prev.stage || null,
    rolledBack: typeof msg.rolledBack === "boolean" ? msg.rolledBack : !!prev.rolledBack,
    message: msg.message || msg.error || null,
    updateError: isFailed ? (msg.error || msg.message || null) : null,
    updatedAt: new Date()
  };
  updateStates.set(msg.deviceId, state);
  return state;
}

function shouldMarkUpdateSuccess(pend, agentVersion) {
  return !!(
    pend &&
    pend.targetVersion &&
    pend.status !== "update_success" &&
    pend.status !== "update_failed" &&
    agentVersion &&
    agentVersion === pend.targetVersion
  );
}

function applyRegisterUpdateSuccess(deviceId, agentVersion) {
  const pend = updateStates.get(deviceId);
  if (!shouldMarkUpdateSuccess(pend, agentVersion)) return pend || null;
  const state = {
    ...pend,
    status: "update_success",
    version: agentVersion,
    message: "Atualizacao concluida",
    updateError: null,
    updatedAt: new Date()
  };
  updateStates.set(deviceId, state);
  return state;
}

// Envia uma mensagem para o Agent conectado com o deviceId informado.
// Retorna true se havia um Agent conectado.
function sendToAgent(deviceId, obj) {
  if (!wssRef) return false;
  let found = false;
  wssRef.clients.forEach((ws) => {
    if (ws.deviceId === deviceId && ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
        found = true;
      } catch (e) {
        // falha ao enviar para este cliente
      }
    }
  });
  return found;
}

function markOffline(deviceId, exceptWs) {
  if (!deviceId) return;
  // Não marca offline se ainda houver outra conexão WebSocket viva (OPEN)
  // para o mesmo deviceId. O próprio socket que está fechando (exceptWs) é
  // ignorado para não ser contado como conexão válida.
  if (wssRef) {
    let live = false;
    wssRef.clients.forEach((ws) => {
      if (ws === exceptWs) return;
      if (ws.deviceId === deviceId && ws.readyState === ws.OPEN) live = true;
    });
    if (live) return;
  }
  clearCapabilities(deviceId);
  prisma.computador
    .updateMany({
      where: { deviceId },
      data: { status: "offline" }
    })
    .catch((err) => {
      console.error("[Monitor TI] erro ao marcar offline:", err.message);
    });
}

function handleMetrics(d) {
  return new Promise((resolve) => {
    (async () => {
      const existente = await prisma.computador.findUnique({
        where: { deviceId: d.deviceId }
      });
      // Nao cria computador via metrics; apenas atualiza registro existente
      if (!existente) return resolve(false);

      const cpu = Number(d.cpu);
      const ramTotal = Number(d.ramTotal);
      const ramUsada = Number(d.ramUsada);
      const uptime = Number(d.uptime);

      if (![cpu, ramTotal, ramUsada, uptime].every(Number.isFinite)) {
        return resolve(false);
      }

      const discoTotal =
        d.discoTotal === null || d.discoTotal === undefined
          ? null
          : Number(d.discoTotal);
      const discoLivre =
        d.discoLivre === null || d.discoLivre === undefined
          ? null
          : Number(d.discoLivre);

      if (
        (discoTotal !== null && !Number.isFinite(discoTotal)) ||
        (discoLivre !== null && !Number.isFinite(discoLivre))
      ) {
        return resolve(false);
      }

      await prisma.computador.update({
        where: { deviceId: d.deviceId },
        data: {
          status: "online",
          ultimaConexao: new Date(),
          cpuUso: cpu,
          ramTotal,
          ramUsada,
          discoTotal,
          discoLivre,
          uptime,
          ultimaMetrica: new Date()
        }
      });

      const state = {
        computadorId: existente.id,
        cpuUso: cpu,
        ramTotal,
        ramUsada,
        discoTotal,
        discoLivre
      };
      historicoService.maybeSaveSample(state).catch(() => {});
      alertasService.avaliar(state).catch(() => {});

      resolve(true);
    })().catch((err) => {
      console.error("[Monitor TI] erro no metrics:", err.message);
      resolve(false);
    });
  });
}

function setupWebSocket(server, dependencies = {}) {
  const db = dependencies.prisma || prisma;
  const actionsService = dependencies.remoteActionsService || remoteActionsService;
  const noticesService = dependencies.avisosService || avisosService;
  const wss = new WebSocketServer({ server });
  wssRef = wss;

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        markOffline(ws.deviceId, ws);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);

  wss.on("connection", (ws) => {
    ws.isAlive = true;
    ws.deviceId = null;

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (raw) => {
      Promise.resolve().then(async () => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      // Avisos remotos: confirmacoes vindas do Agent
      if (msg && msg.type === "notice_received" && msg.deviceId && msg.noticeDeliveryId) {
        avisosService.marcarExibido(msg.noticeDeliveryId, msg.deviceId).catch(() => {});
        return;
      }
      if (msg && msg.type === "notice_acknowledged" && msg.deviceId && msg.noticeDeliveryId) {
        avisosService.marcarConfirmado(msg.noticeDeliveryId, msg.deviceId).catch(() => {});
        return;
      }

      if (msg && msg.type === "capabilities" && (msg.deviceId || ws.deviceId)) {
        const dev = msg.deviceId || ws.deviceId;
        setCapabilities(dev, msg.data && msg.data.capabilities);
        console.log(`[Monitor TI] capacidades de ${dev}: ${getCapabilities(dev).join(",") || "(vazio)"}`);
        return;
      }

      if (msg && msg.type === "update_status" && msg.deviceId) {
        const state = applyUpdateStatusMessage(msg);
        console.log(
          `[Monitor TI] update_status ${msg.deviceId}: ${msg.status}` +
            (msg.message || msg.error ? ` (${msg.message || msg.error})` : "")
        );
        return;
      }

      if (msg && msg.type === "remote_action_reconcile" && Array.isArray(msg.executions)) {
        const accepted = [];
        const rejected = [];
        logger.logEvent(
          `[Monitor TI] remote_action_reconcile_received deviceId=${msg.deviceId || "-"} count=${msg.executions.length}`
        );
        if (!ws.deviceId || msg.deviceId !== ws.deviceId) {
          ws.send(JSON.stringify({
            type: "remote_action_reconcile_result",
            protocolVersion: 1,
            deviceId: msg.deviceId || null,
            accepted,
            rejected: [{ actionExecutionId: null, error: "deviceId não corresponde à conexão registrada." }]
          }));
          logger.logEvent(
            `[Monitor TI] remote_action_reconcile_processed received=${msg.executions.length} accepted=0 ignored=0 rejected=1 acked=0`
          );
          return;
        }
        let acked = 0;
        for (const item of msg.executions.slice(0, 100)) {
          try {
            const result = await actionsService.reconcileAgentStatusMessage({
              ...item,
              deviceId: msg.deviceId,
              reconcile: true
            });
            if (result.accepted) {
              accepted.push(item.actionExecutionId);
              if (["SUCCESS", "FAILED", "REJECTED"].includes(String(item.status).toUpperCase())) {
                ws.send(JSON.stringify({
                  type: "remote_action_status_ack",
                  protocolVersion: 1,
                  deviceId: msg.deviceId,
                  actionExecutionId: item.actionExecutionId,
                  status: String(item.status).toUpperCase()
                }));
                acked += 1;
                logger.logEvent(
                  `[Monitor TI] remote_action_status_ack_sent actionExecutionId=${item.actionExecutionId} status=${String(item.status).toUpperCase()}`
                );
              }
            } else {
              rejected.push({ actionExecutionId: item.actionExecutionId || null, error: result.error });
              logger.logEvent(
                `[Monitor TI] remote_action_reconcile_item_rejected actionExecutionId=${item.actionExecutionId || "-"} status=${String(item.status || "-").toUpperCase()} currentStatus=${result.execution && result.execution.status || "-"} reason=${result.reason || "unknown"}`
              );
            }
          } catch (err) {
            rejected.push({ actionExecutionId: item.actionExecutionId || null, error: err.message });
            const details = summarizeReconciliationError(err);
            logger.logEvent(
              `[Monitor TI] remote_action_reconcile_item_rejected actionExecutionId=${item.actionExecutionId || "-"} status=${String(item.status || "-").toUpperCase()} currentStatus=- reason=exception stage=reconcileAgentStatusMessage errorName=${details.name} errorMessage=${details.message} stack=${details.stack}`
            );
          }
        }
        ws.send(JSON.stringify({
          type: "remote_action_reconcile_result",
          protocolVersion: 1,
          deviceId: msg.deviceId,
          accepted,
          rejected
        }));
        logger.logEvent(
          `[Monitor TI] remote_action_reconcile_processed received=${msg.executions.length} accepted=${accepted.length} ignored=0 rejected=${rejected.length} acked=${acked}`
        );
        return;
      }

      if (msg && msg.type === "remote_action_status" && msg.actionExecutionId) {
        const state = await actionsService.applyAgentStatusMessage(msg);
        if (state) {
          console.log(
            `[Monitor TI] remote_action_status ${msg.actionExecutionId}: ${state.status}` +
              (state.mensagem || state.erro ? ` (${state.mensagem || state.erro})` : "")
          );
          if (["SUCCESS", "FAILED", "REJECTED"].includes(state.status)) {
            ws.send(JSON.stringify({
              type: "remote_action_status_ack",
              protocolVersion: 1,
              deviceId: msg.deviceId || ws.deviceId,
              actionExecutionId: msg.actionExecutionId,
              status: state.status
            }));
            logger.logEvent(
              `[Monitor TI] remote_action_status_ack_sent actionExecutionId=${msg.actionExecutionId} status=${state.status}`
            );
          }
        }
        return;
      }

      if (msg && msg.type === "register" && msg.data && msg.data.deviceId) {
        const d = msg.data;
        try {
          const computador = await db.computador.upsert({
            where: { deviceId: d.deviceId },
            create: {
              deviceId: d.deviceId,
              hostname: d.hostname || "",
              usuario: d.usuario || null,
              ip: d.ip || null,
              sistema: d.sistema || null,
              arquitetura: d.arquitetura || null,
              processador: d.processador || null,
              cpusLogicas: d.cpusLogicas != null ? Number(d.cpusLogicas) : null,
              sistemaRelease: d.sistemaRelease || null,
              fabricante: d.fabricante || null,
              modeloEquipamento: d.modeloEquipamento || null,
              placaMaeFabricante: d.placaMaeFabricante || null,
              placaMaeModelo: d.placaMaeModelo || null,
              biosFabricante: d.biosFabricante || null,
              biosVersao: d.biosVersao || null,
              numeroSerie: d.numeroSerie || null,
              agentVersion: d.agentVersion || null,
              status: "online",
              ultimaConexao: new Date()
            },
            update: {
              hostname: d.hostname || "",
              usuario: d.usuario || null,
              ip: d.ip || null,
              sistema: d.sistema || null,
              arquitetura: d.arquitetura || null,
              processador: d.processador || null,
              cpusLogicas: d.cpusLogicas != null ? Number(d.cpusLogicas) : null,
              sistemaRelease: d.sistemaRelease || null,
              fabricante: d.fabricante || null,
              modeloEquipamento: d.modeloEquipamento || null,
              placaMaeFabricante: d.placaMaeFabricante || null,
              placaMaeModelo: d.placaMaeModelo || null,
              biosFabricante: d.biosFabricante || null,
              biosVersao: d.biosVersao || null,
              numeroSerie: d.numeroSerie || null,
              agentVersion: d.agentVersion || null,
              status: "online",
              ultimaConexao: new Date()
            }
          });
          ws.deviceId = d.deviceId;
          applyRegisterCapabilities(d.deviceId, d.capabilities);
          console.log(`[Monitor TI] registrado: ${d.hostname} (${d.deviceId})`);
          ws.send(JSON.stringify({
            type: "remote_action_reconcile_request",
            protocolVersion: 1,
            deviceId: d.deviceId
          }));
          logger.logEvent(
            `[Monitor TI] remote_action_reconcile_request_sent deviceId=${d.deviceId} computadorId=${computador.id}`
          );

          // Entrega avisos pendentes (envio imediato que ocorreu com o Agent
          // offline, ou reenvio apos reconexao dentro da validade).
          noticesService
            .obterPendentesDoDispositivo(d.deviceId)
            .catch((err) =>
              console.error("[Monitor TI] erro ao enviar avisos pendentes:", err.message)
            );

          // Detecta conclusão bem-sucedida de uma atualização em andamento
          const pend = updateStates.get(d.deviceId);
          if (shouldMarkUpdateSuccess(pend, d.agentVersion)) {
            updateStates.set(d.deviceId, {
              ...pend,
              status: "update_success",
              version: d.agentVersion,
              message: "Atualizacao concluida",
              updateError: null,
              updatedAt: new Date()
            });
            console.log(
              `[Monitor TI] atualizacao concluida: ${d.hostname} -> ${d.agentVersion}`
            );
          }

          // Sincroniza os discos fisicos (delete + insert) em transacao
          try {
            const discoData = Array.isArray(d.discosFisicos)
              ? d.discosFisicos.filter(Boolean)
              : [];
            await db.$transaction(async (tx) => {
              await tx.discoFisico.deleteMany({
                where: { computadorId: computador.id }
              });
              if (discoData.length) {
                await tx.discoFisico.createMany({
                  data: discoData.map((x) => ({
                    computadorId: computador.id,
                    modelo: x.modelo || null,
                    tamanho: x.tamanho != null ? Number(x.tamanho) : null,
                    interface: x.interface || null
                  }))
                });
              }
            });
          } catch (err) {
            console.error("[Monitor TI] erro ao sincronizar discos:", err.message);
          }
        } catch (err) {
          console.error("[Monitor TI] erro no register:", err.message);
        }
      } else if (msg && msg.type === "metrics" && msg.data && msg.data.deviceId) {
        await handleMetrics(msg.data);
      }
      }).catch((err) => {
        let context = {};
        try {
          const msg = JSON.parse(raw.toString());
          context = {
            actionExecutionId: msg && msg.actionExecutionId,
            deviceId: msg && msg.deviceId,
            action: msg && msg.action,
            status: msg && msg.status
          };
        } catch (parseErr) {
          context = {};
        }
        const summary = String(err && err.message ? err.message : err).replace(/[\r\n]+/g, " ").slice(0, 1000);
        const stack = String(err && err.stack ? err.stack : "").replace(/[\r\n]+/g, " ").slice(0, 2000);
        logger.logEvent(
          `[Monitor TI] erro ao processar mensagem Agent actionExecutionId=${context.actionExecutionId || "-"}` +
          ` deviceId=${context.deviceId || ws.deviceId || "-"} action=${context.action || "-"}` +
          ` status=${context.status || "-"} erro=${summary}` +
          (stack ? ` stack=${stack}` : "")
        );
      });
    });

    ws.on("close", () => {
      markOffline(ws.deviceId, ws);
    });

    ws.on("error", () => {});
  });

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  return wss;
}

module.exports = {
  setupWebSocket,
  sendToAgent,
  getUpdateState,
  setUpdateState,
  clearUpdateState,
  resetUpdateStatesForTests,
  applyRegisterCapabilities,
  clearCapabilities,
  applyUpdateStatusMessage,
  shouldMarkUpdateSuccess,
  applyRegisterUpdateSuccess,
  setCapabilities,
  getCapabilities,
  hasCapability
};
