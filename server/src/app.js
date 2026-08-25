require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");

const healthRoutes = require("./routes/health.routes");
const computadoresRoutes = require("./routes/computadores.routes");
const { setupWebSocket } = require("./ws/agentServer");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/health", healthRoutes);
app.use("/api/computadores", computadoresRoutes);

app.get("/", (req, res) => {
  res.json({ name: "Monitor TI Server", status: "ok" });
});

const PORT = process.env.PORT || 4000;

if (require.main === module) {
  const server = http.createServer(app);
  setupWebSocket(server);

  server.listen(PORT, () => {
    console.log(`[Monitor TI] Server rodando na porta ${PORT}`);
  });
}

module.exports = app;
