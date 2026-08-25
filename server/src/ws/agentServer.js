const { WebSocketServer } = require("ws");
const prisma = require("../prisma");

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
          await prisma.computador.upsert({
            where: { deviceId: d.deviceId },
            create: {
              deviceId: d.deviceId,
              hostname: d.hostname || "",
              usuario: d.usuario || null,
              ip: d.ip || null,
              sistema: d.sistema || null,
              status: "online",
              ultimaConexao: new Date()
            },
            update: {
              hostname: d.hostname || "",
              usuario: d.usuario || null,
              ip: d.ip || null,
              sistema: d.sistema || null,
              status: "online",
              ultimaConexao: new Date()
            }
          });
          ws.deviceId = d.deviceId;
          console.log(`[Monitor TI] registrado: ${d.hostname} (${d.deviceId})`);
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
