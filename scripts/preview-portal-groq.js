const express = require("../server/node_modules/express");
const { createPortalLucaService } = require("../server/src/services/portalLuca.service");

const PORT = Number(process.env.LUCA_PREVIEW_PORT || 4174);
const app = express();
const requests = [];
const session = { hostname: "PREVIEW-GROQ", usuarioWindows: "Henrique", identificacao: "Prévia isolada · catálogo sintético" };
const certificates = [
  { id: 101, nomeExibicao: "Alfa Fictícia · ICP-Brasil A1", nomeEmpresa: "Alfa Fictícia", documento: "12.345.678/0001-90", extensao: ".pfx", anoReferencia: 2026, pastaLogica: "alfa-ficticia" },
  { id: 102, nomeExibicao: "Alfa Fictícia · ICP-Brasil A3", nomeEmpresa: "Alfa Fictícia", documento: "12.345.678/0001-90", extensao: ".p12", anoReferencia: 2026, pastaLogica: "alfa-ficticia" },
  { id: 103, nomeExibicao: "Beta Sintética · e-CNPJ A1", nomeEmpresa: "Beta Sintética", documento: "98.765.432/0001-10", extensao: ".pfx", anoReferencia: 2026, pastaLogica: "beta-sintetica" },
  { id: 104, nomeExibicao: "Cenário duplicidade · certificado sintético", nomeEmpresa: "Cenário Duplicidade", documento: "00.000.000/0001-04", extensao: ".pfx", anoReferencia: 2026, pastaLogica: "preview" },
  { id: 105, nomeExibicao: "Cenário falha API · certificado sintético", nomeEmpresa: "Cenário Falha API", documento: "00.000.000/0001-05", extensao: ".pfx", anoReferencia: 2026, pastaLogica: "preview" }
];

const luca = createPortalLucaService({
  provider: "groq",
  groqModel: "openai/gpt-oss-20b",
  groqApiKey: process.env.GROQ_API_KEY,
  log: () => {}
});

app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok", preview: true, provider: "groq", model: "openai/gpt-oss-20b", catalog: "synthetic" }));
app.post("/api/portal/session", (_req, res) => res.status(200).json(session));
app.get("/api/portal/session", (_req, res) => res.status(200).json({ ...session, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString() }));
app.get("/api/portal/browser-notifications/status", (_req, res) => res.json({ enabled: false }));
app.get("/api/portal/solicitacoes", (_req, res) => res.json({ items: requests, total: requests.length, page: 1, pageSize: 100, totalPages: 1 }));
app.get("/api/portal/certificados", (req, res) => {
  const query = String(req.query.q || "").trim().toLowerCase();
  const items = query ? certificates.filter((certificate) => `${certificate.nomeExibicao} ${certificate.nomeEmpresa} ${certificate.documento}`.toLowerCase().includes(query)) : certificates;
  res.json({ items, total: items.length, page: 1, pageSize: Number(req.query.pageSize || 10), totalPages: 1 });
});
app.post("/api/portal/luca/conversa", async (req, res) => {
  try {
    const result = await luca.converse({ conversationKey: "preview-computer", sessionId: req.body.sessionId, message: req.body.message, phase: req.body.phase });
    res.json(result);
  } catch (error) {
    res.status(error.status || 503).json({ erro: error.message || "O Luca está indisponível." });
  }
});
app.post("/api/portal/solicitacoes", (req, res) => {
  const certificadoId = Number(req.body.certificadoId);
  const certificate = certificates.find((item) => item.id === certificadoId);
  if (!certificate) return res.status(400).json({ erro: "Certificado sintético inválido." });
  if (certificadoId === 105) return res.status(503).json({ erro: "Falha sintética da API de criação." });
  if (certificadoId === 104 || requests.some((item) => item.certificado?.id === certificadoId && item.estado === "PENDENTE")) return res.status(409).json({ erro: "Já existe uma solicitação pendente deste certificado para esta estação." });
  const request = { id: requests.length + 1, protocolo: `PREVIEW-${requests.length + 1}`, estado: "PENDENTE", motivo: String(req.body.motivo || "").trim() || null, solicitadoEm: new Date().toISOString(), certificado: certificate };
  requests.push(request);
  return res.status(201).json(request);
});

const server = app.listen(PORT, "127.0.0.1", () => console.log(`Luca preview API: http://127.0.0.1:${PORT}`));
function shutdown() { server.close(() => process.exit(0)); }
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
