const { WebSocketServer } = require("ws");
const prisma = require("../prisma");
const historicoService = require("../services/historico.service");
const alertasService = require("../services/alertas.service");

const HEARTBEAT_INTERVAL = 30000;

function markOffline(deviceId) {
  if (!deviceId) return;
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

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) {
        markOffline(ws.deviceId);
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

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      if (msg && msg.type === "register" && msg.data && msg.data.deviceId) {
        const d = msg.data;
        try {
          const computador = await prisma.computador.upsert({
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
              status: "online",
              ultimaConexao: new Date()
            }
          });
          ws.deviceId = d.deviceId;
          console.log(`[Monitor TI] registrado: ${d.hostname} (${d.deviceId})`);

          // Sincroniza os discos fisicos (delete + insert) em transacao
          try {
            const discoData = Array.isArray(d.discosFisicos)
              ? d.discosFisicos.filter(Boolean)
              : [];
            await prisma.$transaction(async (tx) => {
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
    });

    ws.on("close", () => {
      markOffline(ws.deviceId);
    });

    ws.on("error", () => {});
  });

  wss.on("close", () => {
    clearInterval(heartbeat);
  });

  return wss;
}

module.exports = { setupWebSocket };
