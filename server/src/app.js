require("dotenv").config();
const express = require("express");
const cors = require("cors");

const healthRoutes = require("./routes/health.routes");

const app = express();

app.use(cors());
app.use(express.json());

app.use("/health", healthRoutes);

app.get("/", (req, res) => {
  res.json({ name: "Monitor TI Server", status: "ok" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`[Monitor TI] Server rodando na porta ${PORT}`);
});

module.exports = app;
