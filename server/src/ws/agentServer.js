const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");
const { normalizeIp } = require("../networkIp");
const prisma = require("../prisma");
const historicoService = require("../services/historico.service");
const alertasService = require("../services/alertas.service");
const avisosService = require("../services/avisos.service");
const remoteActionsService = require("../services/remoteActions.service");
const { validateInventoryMessage } = require("../inventory/office");
const { persistOfficeInventory } = require("../inventory/persistence");
const { queueComputerInventorySync } = require("../inventory/excelAutoSync");
const logger = require("../logger");
const agentUpdates = require("../services/agentUpdates.service");
const { agentIpConfirmation } = require("../services/agentIpConfirmation.service");
const PILOT_DEVICE_ID = "00000000-0000-4000-8000-000000000001";
const PILOT_EVENT_TYPE = "CERTIFICATE_NOTIFICATION_TEST";
const PILOT_MESSAGE_TYPE = "certificate_notification_test";
const PILOT_ACK_TYPE = "certificate_notification_test_ack";
const PILOT_CAPABILITY = "certificate_notification_test_v1";
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PILOT_ACK_STATUSES = new Set(["RECEIVED", "DISPLAYED", "DUPLICATE", "FAILED"]);
const PILOT_ACK_CODES = new Set([
  "PILOT_DISABLED",
  "INVALID_EVENT",
  "TOAST_UNAVAILABLE",
  "TOAST_DISPLAY_FAILED",
  "COMPANION_UNAVAILABLE"
]);

const HEARTBEAT_INTERVAL = 30000;

function readPilotConfig(env = process.env) {
  const enabled = env.MTI_CERTIFICATE_NOTIFICATION_TEST === "1";
  const targetDeviceId = String(env.MTI_CERTIFICATE_NOTIFICATION_TARGET_DEVICE_ID || "");
  const eventId = String(env.MTI_CERTIFICATE_NOTIFICATION_EVENT_ID || "");
  if (!enabled || targetDeviceId !== PILOT_DEVICE_ID || !UUID_RE.test(eventId)) return null;
  return Object.freeze({ targetDeviceId, eventId });
}

let pilotConfig = readPilotConfig();
let pilotState = pilotConfig ? "pending" : "disabled";

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
const connectionsByDeviceId = new Map();
let wssRef = null;

function logPilot(message) {
  logger.logEvent(`[Monitor TI] ${message}`);
}

function mergeCapabilities(target, caps) {
  if (!Array.isArray(caps)) return;
  for (const cap of caps) {
    if (typeof cap === "string" && cap.length > 0 && cap.length <= 100) target.add(cap);
  }
}

function applySocketCapabilities(ws, caps) {
  if (!ws || !Array.isArray(caps)) return;
  mergeCapabilities(ws.registered ? ws.capabilities : ws.pendingCapabilities, caps);
  if (ws.registered && ws.deviceId && connectionsByDeviceId.get(ws.deviceId) === ws) {
    agentCaps.set(ws.deviceId, new Set(ws.capabilities));
  }
}

function setCurrentConnection(ws) {
  if (!ws || !ws.registered || !ws.deviceId) return;
  connectionsByDeviceId.set(ws.deviceId, ws);
  agentCaps.set(ws.deviceId, new Set(ws.capabilities));
}

function isCurrentConnection(ws) {
  return !!ws && ws.registered && connectionsByDeviceId.get(ws.deviceId) === ws;
}

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
  const ws = connectionsByDeviceId.get(deviceId);
  if (!ws || !ws.registered || ws.deviceId !== deviceId || ws.readyState !== ws.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

function sendCertificateNotificationTest(deviceId, send = sendToAgent, socket = null) {
  if (!pilotConfig || deviceId !== pilotConfig.targetDeviceId) return false;
  if (pilotState !== "pending") return false;
  if (!hasCapability(pilotConfig.targetDeviceId, "notices")) return false;
  if (!hasCapability(pilotConfig.targetDeviceId, PILOT_CAPABILITY)) {
    logPilot("PILOT_CAPABILITY_MISSING");
    return false;
  }
  const ws = socket || connectionsByDeviceId.get(deviceId);
  if (send === sendToAgent && (!ws || ws.readyState !== 1 || (!socket && !isCurrentConnection(ws)))) return false;
  logPilot(`PILOT_ELIGIBLE connectionId=${ws && ws.connectionId || "-"}`);
  const payload = {
    type: PILOT_MESSAGE_TYPE,
    eventId: pilotConfig.eventId,
    eventType: PILOT_EVENT_TYPE
  };
  pilotState = "sending";
  logPilot(`PILOT_SEND_STARTED connectionId=${ws && ws.connectionId || "-"}`);

  if (send !== sendToAgent) {
    try {
      const queued = send(deviceId, payload, (error) => {
        if (error) {
          pilotState = "failed";
          logPilot(`PILOT_SEND_FAILED connectionId=${ws && ws.connectionId || "-"} code=SEND_CALLBACK_ERROR`);
          return;
        }
        pilotState = "sent";
        logPilot(`PILOT_SEND_QUEUED connectionId=${ws && ws.connectionId || "-"}`);
      });
      if (queued === false) {
        pilotState = "failed";
        logPilot(`PILOT_SEND_FAILED connectionId=${ws && ws.connectionId || "-"} code=SEND_REJECTED`);
        return false;
      }
      return true;
    } catch (error) {
      pilotState = "failed";
      logPilot(`PILOT_SEND_FAILED connectionId=${ws && ws.connectionId || "-"} code=SEND_THROW`);
      return false;
    }
  }

  if (!ws) {
    pilotState = "failed";
    logPilot("PILOT_SEND_FAILED connectionId=- code=SOCKET_NOT_FOUND");
    return false;
  }
  try {
    ws.send(JSON.stringify(payload), (error) => {
      if (error) {
        pilotState = "failed";
        logPilot(`PILOT_SEND_FAILED connectionId=${ws.connectionId} code=SEND_CALLBACK_ERROR`);
        return;
      }
      pilotState = "sent";
      logPilot(`PILOT_SEND_QUEUED connectionId=${ws.connectionId}`);
    });
    return true;
  } catch (error) {
    pilotState = "failed";
    logPilot(`PILOT_SEND_FAILED connectionId=${ws.connectionId} code=SEND_THROW`);
    return false;
  }
}

async function maybeDispatchCertificateNotificationTest(deviceId, socket = null) {
  return sendCertificateNotificationTest(deviceId, sendToAgent, socket);
}

function logPilotAck(ws, msg) {
  if (!pilotConfig || !ws || ws.deviceId !== pilotConfig.targetDeviceId) return false;
  if (!msg || msg.type !== PILOT_ACK_TYPE || msg.eventId !== pilotConfig.eventId) return false;
  if (Object.keys(msg).some((key) => !["type", "eventId", "status", "errorCode"].includes(key))) return false;
  if (!PILOT_ACK_STATUSES.has(msg.status)) return false;
  const errorCode = msg.errorCode == null ? null : String(msg.errorCode);
  if (errorCode !== null && !PILOT_ACK_CODES.has(errorCode)) return false;
  if (pilotState !== "sent" && msg.status !== "RECEIVED") return false;
  if (msg.status !== "RECEIVED") pilotState = msg.status === "FAILED" ? "failed" : "acknowledged";
  logPilot(`PILOT_ACK_RECEIVED connectionId=${ws.connectionId || "-"} status=${msg.status}` +
    ` code=${errorCode || "-"}`);
  return true;
}

function resetPilotStateForTests() {
  pilotState = pilotConfig ? "pending" : "disabled";
}

function getPilotStateForTests() {
  return pilotState;
}

function reloadPilotConfigForTests(env = process.env) {
  pilotConfig = readPilotConfig(env);
  resetPilotStateForTests();
  return pilotConfig;
}

function markOffline(deviceId, exceptWs, db = prisma) {
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
  db.computador
    .updateMany({
      where: { deviceId },
      data: { status: "offline" }
    })
    .catch((err) => {
      console.error("[Monitor TI] erro ao marcar offline:", err.message);
    });
}

function handleMetrics(d, db = prisma, ws = null, services = {}) {
  return new Promise((resolve) => {
    (async () => {
      const existente = await db.computador.findUnique({
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

      const reportedIp = normalizeIp(d.ip);
      await db.computador.update({
        where: { deviceId: d.deviceId },
        data: {
          status: "online",
          ultimaConexao: new Date(),
          ...(reportedIp ? { ip: reportedIp } : {}),
          cpuUso: cpu,
          ramTotal,
          ramUsada,
          discoTotal,
          discoLivre,
          uptime,
          ultimaMetrica: new Date()
        }
      });
      if (reportedIp && ws?.deviceId === d.deviceId) agentIpConfirmation.confirm(d.deviceId, ws.connectionId, reportedIp);
      queueComputerInventorySync({ db, computadorId: existente.id, includeStorage: false, mergeWithLatest: false, log: (message) => logger.logEvent(`[Monitor TI] ${message}`) }).catch(() => {});

      const state = {
        computadorId: existente.id,
        cpuUso: cpu,
        ramTotal,
        ramUsada,
        discoTotal,
        discoLivre
      };
      (services.historicoService || historicoService).maybeSaveSample(state).catch(() => {});
      (services.alertasService || alertasService).avaliar(state).catch(() => {});

      resolve(true);
    })().catch((err) => {
      console.error("[Monitor TI] erro no metrics:", err.message);
      resolve(false);
    });
  });
}

function setupWebSocket(server, dependencies = {}) {
  if (process.env.NODE_ENV === "test" && !dependencies.prisma) {
    throw new Error("setupWebSocket em NODE_ENV=test exige prisma explicitamente injetado");
  }
  const db = dependencies.prisma || prisma;
  const actionsService = dependencies.remoteActionsService || remoteActionsService;
  const noticesService = dependencies.avisosService || avisosService;
  const wss = new WebSocketServer({ server });
  wssRef = wss;

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        markOffline(ws.deviceId, ws, db);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL);
  if (typeof heartbeat.unref === "function") heartbeat.unref();
  wss.stopHeartbeat = () => clearInterval(heartbeat);

  wss.on("connection", (ws) => {
    ws.connectionId = randomUUID();
    ws.isAlive = true;
    ws.deviceId = null;
    ws.registered = false;
    ws.capabilities = new Set();
    ws.pendingCapabilities = new Set();

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

      if (msg && msg.type === PILOT_ACK_TYPE) {
        logPilotAck(ws, msg);
        return;
      }

      if (msg && msg.type === "capabilities" && (msg.deviceId || ws.deviceId)) {
        if (msg.deviceId && ws.deviceId && msg.deviceId !== ws.deviceId) return;
        const dev = ws.deviceId || msg.deviceId;
        applySocketCapabilities(ws, msg.data && msg.data.capabilities);
        if (!ws.registered) {
          logPilot(`CAPABILITIES_BUFFERED connectionId=${ws.connectionId}`);
        } else {
          logPilot(`CAPABILITIES_APPLIED connectionId=${ws.connectionId}`);
          await maybeDispatchCertificateNotificationTest(dev, ws);
        }
        console.log(`[Monitor TI] capacidades de ${dev}: ${Array.from(ws.registered ? ws.capabilities : ws.pendingCapabilities).join(",") || "(vazio)"}`);
        return;
      }

      if (msg && msg.type === "update_status") {
        if (!ws.deviceId) {
          logger.logEvent("[Monitor TI] update_status rejeitado: conexão não registrada");
          return;
        }
        if (msg.deviceId && msg.deviceId !== ws.deviceId) {
          logger.logEvent(`[Monitor TI] security_event=update_status_device_mismatch connectionDeviceId=${ws.deviceId} payloadDeviceId=${msg.deviceId}`);
          return;
        }
        const state = applyUpdateStatusMessage({ ...msg, deviceId: ws.deviceId });
        agentUpdates.applyAgentStatus(db, ws.deviceId, msg).catch((err) => {
          logger.logEvent(`[Monitor TI] update_status persistence failed deviceId=${ws.deviceId} reason=${err.message}`);
        });
        console.log(
          `[Monitor TI] update_status ${msg.deviceId}: ${msg.status}` +
            (msg.message || msg.error ? ` (${msg.message || msg.error})` : "")
        );
        return;
      }

      if (msg && msg.type === "inventory") {
        const validation = validateInventoryMessage(msg, ws.deviceId);
        if (!validation.ok) {
          logger.logEvent(`[Monitor TI] inventory rejected reason=${validation.reason}`);
          return;
        }
        const computador = await db.computador.findUnique({
          where: { deviceId: msg.deviceId },
          select: { id: true }
        });
        if (!computador) {
          logger.logEvent("[Monitor TI] inventory rejected reason=computer_not_found");
          return;
        }
        try {
          await persistOfficeInventory({ db, computadorId: computador.id, office: msg.data.office });
          await queueComputerInventorySync({ db, computadorId: computador.id, includeOffice: true, log: (message) => logger.logEvent(`[Monitor TI] ${message}`) });
          logger.logEvent(`[Monitor TI] inventory received computerId=${computador.id} officeInstallationsCount=${validation.installationCount}`);
        } catch (error) {
          logger.logEvent(`[Monitor TI] inventory persistence failed computerId=${computador.id} reason=${String(error && (error.code || error.message) || "unknown").replace(/[\r\n]+/g, " ").slice(0, 160)}`);
        }
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
        const reportedIp = normalizeIp(d.ip);
        try {
          if (d.updateStatusOnly === true) {
            const existing = await db.computador.findUnique({ where: { deviceId: d.deviceId }, select: { id: true } });
            if (!existing) return;
            ws.deviceId = d.deviceId;
            ws.send(JSON.stringify({ type: "register_ack", deviceId: d.deviceId, updateStatusOnly: true }));
            return;
          }
          const computador = await db.computador.upsert({
            where: { deviceId: d.deviceId },
            create: {
              deviceId: d.deviceId,
              hostname: d.hostname || "",
              usuario: d.usuario || null,
              ip: reportedIp,
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
              ...(reportedIp ? { ip: reportedIp } : {}),
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
          const socketIp = normalizeIp(ws._socket && ws._socket.remoteAddress);
          logger.logEvent(`[Monitor TI] agent_ip_observed deviceId=${d.deviceId} socketIp=${socketIp || "-"} reportedIp=${reportedIp || "-"} persistedIp=${computador.ip || "-"}`);
          ws.deviceId = d.deviceId;
          if (reportedIp) agentIpConfirmation.confirm(d.deviceId, ws.connectionId, reportedIp);
          else agentIpConfirmation.clear(d.deviceId, ws.connectionId);
          ws.registered = true;
          ws.capabilities = new Set(ws.pendingCapabilities);
          setCurrentConnection(ws);
          applySocketCapabilities(ws, d.capabilities);
          logPilot(`REGISTER_COMPLETED connectionId=${ws.connectionId}`);
          logPilot(`CAPABILITIES_APPLIED connectionId=${ws.connectionId}`);
          await maybeDispatchCertificateNotificationTest(d.deviceId, ws);
            console.log(`[Monitor TI] registrado: ${d.hostname} (${d.deviceId})`);
           ws.send(JSON.stringify({ type: "register_ack", protocolVersion: 1, deviceId: d.deviceId }));
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
          agentUpdates.markSuccessOnRegister(db, d.deviceId, d.agentVersion).catch((err) => {
            logger.logEvent(`[Monitor TI] update success persistence failed deviceId=${d.deviceId} reason=${err.message}`);
          });

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
            queueComputerInventorySync({ db, computadorId: computador.id, log: (message) => logger.logEvent(`[Monitor TI] ${message}`) }).catch(() => {});
          } catch (err) {
            console.error("[Monitor TI] erro ao sincronizar discos:", err.message);
          }
        } catch (err) {
          console.error("[Monitor TI] erro no register:", err.message);
        }
      } else if (msg && msg.type === "metrics" && msg.data && msg.data.deviceId) {
        await handleMetrics(msg.data, db, ws, { historicoService: dependencies.historicoService, alertasService: dependencies.alertasService });
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
      if (ws.deviceId && connectionsByDeviceId.get(ws.deviceId) === ws) {
        connectionsByDeviceId.delete(ws.deviceId);
        clearCapabilities(ws.deviceId);
      }
      agentIpConfirmation.clear(ws.deviceId, ws.connectionId);
      logPilot(`CONNECTION_CLOSED connectionId=${ws.connectionId} registered=${ws.registered ? "true" : "false"}`);
      markOffline(ws.deviceId, ws, db);
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
  sendCertificateNotificationTest,
  maybeDispatchCertificateNotificationTest,
  handleCertificateNotificationTestAck: logPilotAck,
  reloadPilotConfigForTests,
  resetPilotStateForTests,
  getPilotStateForTests,
  PILOT_DEVICE_ID,
  PILOT_CAPABILITY,
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
