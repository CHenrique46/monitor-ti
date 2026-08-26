require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");

const healthRoutes = require("./routes/health.routes");
const computadoresRoutes = require("./routes/computadores.routes");
const { setupWebSocket } = require("./ws/agentServer");
const prisma = require("./prisma");
const { logEvent } = require("./logger");

const app = express();

app.use(express.json());

app.use("/health", healthRoutes);
app.use("/api/computadores", computadoresRoutes);

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

if (require.main === module) {
  const server = http.createServer(app);
  setupWebSocket(server);

  server.listen(PORT, "0.0.0.0", () => {
    logEvent(`[Monitor TI] Server rodando na porta ${PORT}`);
  });

  waitForDatabase();
}

module.exports = app;
