const http = require("http");
const { URL } = require("url");

const PORT = 4017;
const requests = [];
const certificates = [
  { id: 101, nomeExibicao: "Empresa Sintetica Alfa", nomeEmpresa: "Empresa Sintetica Alfa", documento: "12.***.***/****-**", validadeFim: "2027-12-31T00:00:00.000Z", statusValidade: "VALIDO_CONFIRMADO", extensao: ".pfx", anoReferencia: 2027 },
  { id: 102, nomeExibicao: "Empresa Sintetica Beta", nomeEmpresa: "Empresa Sintetica Beta", documento: "98.***.***/****-**", validadeFim: "2026-08-31T00:00:00.000Z", statusValidade: "VALIDADE_ESTIMADA", extensao: ".pfx", anoReferencia: 2026 }
];

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://127.0.0.1:5174",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(body));
}

function searchCatalog(query) {
  const value = String(query.get("q") || "").toLowerCase();
  if (value.includes("nenhum")) return [];
  if (value.includes("multi")) return certificates;
  if (value.includes("beta")) return [certificates[1]];
  return [certificates[0]];
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/api/portal/session" && ["GET", "POST"].includes(req.method)) {
    return send(res, 200, { hostname: "PC-SINTETICO", usuarioWindows: "usuario.teste", expiresAt: new Date(Date.now() + 900000).toISOString(), identificacao: "Sessao sintetica isolada para previa." });
  }
  if (url.pathname === "/api/auth/me" && req.method === "GET") return send(res, 200, { username: "usuario.teste", role: "VIEWER" });
  if (url.pathname === "/api/portal/browser-notifications/status" && req.method === "GET") return send(res, 200, { enabled: false });
  if (url.pathname === "/api/portal/certificados" && req.method === "GET") {
    const items = searchCatalog(url.searchParams);
    return send(res, 200, { items, total: items.length, page: 1, pageSize: 5, totalPages: 1 });
  }
  if (url.pathname === "/api/portal/solicitacoes" && req.method === "GET") {
    return send(res, 200, { items: requests, total: requests.length, page: 1, pageSize: 100, totalPages: 1 });
  }
  if (url.pathname === "/api/portal/solicitacoes" && req.method === "POST") {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const input = JSON.parse(raw || "{}");
      if (requests.some((item) => item.certificado.id === input.certificadoId && item.estado === "PENDENTE")) return send(res, 409, { erro: "Ja existe uma solicitacao pendente deste certificado para esta estacao." });
      const certificado = certificates.find((item) => item.id === input.certificadoId);
      if (!certificado) return send(res, 404, { erro: "Certificado nao encontrado." });
      const request = { id: requests.length + 1, protocolo: `SINT-${requests.length + 1}`, estado: "PENDENTE", motivo: input.motivo || null, certificado };
      requests.push(request);
      return send(res, 201, request);
    });
    return;
  }
  return send(res, 404, { erro: "Mock endpoint not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`Previa sintetica em http://127.0.0.1:${PORT}`));
