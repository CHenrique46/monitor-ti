require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");

const healthRoutes = require("./routes/health.routes");
const computadoresRoutes = require("./routes/computadores.routes");
const inventarioRoutes = require("./routes/inventario.routes");
const metricasRoutes = require("./routes/metricas.routes");
const alertasRoutes = require("./routes/alertas.routes");
const { createAgentRouter } = require("./routes/agent.routes");
const avisosRoutes = require("./routes/avisos.routes");
const remoteActionsRoutes = require("./routes/remoteActions.routes");
const wallpaperAssetRoutes = require("./routes/wallpaperAsset.routes");
const maintenanceSchedulerRoutes = require("./routes/maintenanceScheduler.routes");
const maintenanceSchedulerCanaryRoutes = require("./routes/maintenanceSchedulerCanary.routes");
const { createCertificadosRouter } = require("./routes/certificados.routes");
const { createPortalRouter } = require("./routes/portal.routes");
const { createAuthRouter } = require("./routes/auth.routes");
const { createAuthService } = require("./auth/service");
const { requireHumanSession, requireAdmin } = require("./auth/middleware");
const { setupWebSocket } = require("./ws/agentServer");
const prisma = require("./prisma");
const { logEvent } = require("./logger");
const { normalizeComputersOfflineOnStartup } = require("./services/presence.service");
const { recoverOrphanedExecutions } = require("./services/remoteActions.service");
const agentUpdatesService = require("./services/agentUpdates.service");
const historicoService = require("./services/historico.service");
const avisosService = require("./services/avisos.service");
const maintenanceScheduler = require("./services/maintenanceScheduler.service");
const { createExcelSyncWorker } = require("./inventory/excelSyncWorker");
const { createPortalService } = require("./services/portal.service");
const { browserNotificationHub } = require("./services/browserNotificationHub");
const { createBrowserNotificationRouters } = require("./routes/browserNotification.routes");
const certificateCatalogSyncService = require("./services/certificateCatalogSync.service");
const certificateCatalogSyncScheduler = require("./services/certificateCatalogSyncScheduler.service");
const { createShutdownController } = require("./serverLifecycle");

const app = express();
app.locals.shuttingDown = false;
const authService = createAuthService();
const excelSyncWorker = createExcelSyncWorker({ db: prisma, log: (message) => logEvent(`[Monitor TI] ${message}`) });
const portalService = createPortalService({ db: prisma, browserNotifications: browserNotificationHub });

app.use(express.json());
app.use((req, res, next) => {
  if (app.locals.shuttingDown) return res.status(503).json({ status: "shutting_down", erro: "Servidor encerrando." });
  next();
});

app.use("/health", healthRoutes);
app.use("/api/auth", createAuthRouter({ authService }));
const humanSession = requireHumanSession(authService);
app.use("/api/computadores", humanSession, computadoresRoutes);
app.use("/api/inventario", humanSession, inventarioRoutes);
app.use("/api/computadores", humanSession, metricasRoutes);
app.use("/api/alertas", humanSession, alertasRoutes);
app.use("/api/computadores", humanSession, alertasRoutes);
app.use("/api/agent", createAgentRouter({ authService }));
app.use("/api/avisos", humanSession, avisosRoutes);
const portalRoutes = createPortalRouter({ service: portalService, humanSession, requireAdmin });
const browserNotificationRoutes = createBrowserNotificationRouters({ hub: browserNotificationHub, authService, portalService });
app.use("/api/portal", portalRoutes.portal);
app.use("/api/portal/browser-notifications", browserNotificationRoutes.portal);
app.use("/api/certificados", portalRoutes.admin);
app.use("/api/browser-notifications", browserNotificationRoutes.admin);
app.use("/api/certificados", humanSession, createCertificadosRouter({ syncService: certificateCatalogSyncService }));
app.use("/api/computadores", humanSession, remoteActionsRoutes);
app.use("/api/assets", wallpaperAssetRoutes);
app.use("/api/maintenance-schedules", humanSession, maintenanceSchedulerRoutes);
app.use("/internal/maintenance-scheduler/canary", requireHumanSession, requireAdmin(), maintenanceSchedulerCanaryRoutes);

const DIST_DIR = path.join(__dirname, "..", "..", "dashboard", "dist");

app.use(express.static(DIST_DIR));

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path === "/health") {
    return next();
  }
  res.sendFile(path.join(DIST_DIR, "index.html"), (err) => {
    if (err) {
      res.status(404).json({
        erro: "Dashboard nao foi compilado. Execute 'npm run build:production'.",
      });
    }
  });
});

const PORT = process.env.PORT || 4000;

async function waitForDatabase() {
  const maxTentativas = 30;
  const intervaloMs = 2000;
  for (let i = 0; i < maxTentativas; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      logEvent("PostgreSQL conectado com sucesso.");
      return;
    } catch (e) {
      logEvent(
        `PostgreSQL indisponivel, tentando novamente em 2s (${i + 1}/${maxTentativas}): ${e.message}`
      );
      await new Promise((resolve) => setTimeout(resolve, intervaloMs));
    }
  }
  logEvent(
    "AVISO: PostgreSQL nao disponivel apos varias tentativas. O servidor continuara e tentara sob demanda quando o banco estiver acessivel."
  );
}

async function startServer() {
    await waitForDatabase();
    await normalizeComputersOfflineOnStartup();
    try {
      const recovered = await recoverOrphanedExecutions();
      logEvent(`[Monitor TI] execuções remotas órfãs recuperadas: ${recovered}`);
    } catch (err) {
      logEvent(`[Monitor TI] erro ao recuperar execuções remotas órfãs: ${err.message}`);
    }
    try {
      const recoveredUpdates = await agentUpdatesService.recoverExpired(prisma);
      logEvent(`[Monitor TI] atualizações órfãs recuperadas: ${recoveredUpdates.count}`);
    } catch (err) {
      logEvent(`[Monitor TI] erro ao recuperar atualizações órfãs: ${err.message}`);
    }

    await maintenanceScheduler.ensureDefaultSchedule();

    const server = http.createServer(app);
    const wss = setupWebSocket(server);
    const shutdownController = createShutdownController({
      server,
      wss,
      schedulers: [certificateCatalogSyncScheduler, maintenanceScheduler, avisosService, historicoService, excelSyncWorker],
      prisma,
      setShuttingDown: (value) => { app.locals.shuttingDown = value; },
      log: logEvent
    });
    const unregisterSignals = shutdownController.registerSignals(process);

    server.listen(PORT, "0.0.0.0", () => {
      logEvent(`[Monitor TI] Server rodando na porta ${PORT}`);
      certificateCatalogSyncScheduler.start();
    });

    historicoService.iniciarRetencao();
    avisosService.iniciarAgendador();
    maintenanceScheduler.start();
    excelSyncWorker.start();
    return { server, wss, shutdown: shutdownController.shutdown, unregisterSignals };
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error("[Monitor TI] erro no startup:", err.message);
    process.exitCode = 1;
  });
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.createShutdownController = createShutdownController;
