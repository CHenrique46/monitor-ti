const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PREVIEW_PORT || 4017);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434/api/chat";
const OLLAMA_MODEL = "granite3.3:2b";
const MAX_HISTORY = 8;
const MAX_QUEUE = 4;
const REQUEST_TIMEOUT_MS = 15000;
const requests = [];
const conversations = new Map();
const previewStats = { conversationCalls: 0, graniteCalls: 0, catalogCalls: 0, chatCatalogCalls: 0, createCalls: 0, chatCreateCalls: 0 };
const certificates = [
  { id: 101, nomeExibicao: "Empresa Sintetica Alfa", nomeEmpresa: "Empresa Sintetica Alfa", documento: "12.***.***/****-**", validadeFim: "2027-12-31T00:00:00.000Z", statusValidade: "VALIDO_CONFIRMADO", extensao: ".pfx", anoReferencia: 2027 },
  { id: 102, nomeExibicao: "Empresa Sintetica Beta", nomeEmpresa: "Empresa Sintetica Beta", documento: "98.***.***/****-**", validadeFim: "2026-08-31T00:00:00.000Z", statusValidade: "VALIDADE_ESTIMADA", extensao: ".pfx", anoReferencia: 2026 }
];

const SYSTEM_PROMPT = [
  "Voce e Luca, assistente do Escritório Vavá, em uma prévia sintética de pedidos de certificados.",
  "Sua unica funcao e conversar brevemente e conduzir a pessoa ate a busca de um certificado.",
  "Cumprimente, responda agradecimentos, apresente-se, pergunte empresa ou certificado e peca esclarecimento quando faltar informacao.",
  "Se mencionarem problema de computador, diga para procurar Henrique do TI. Nao diagnostique, nao sugira comandos e nao explique suporte tecnico.",
  "Nunca invente catalogo, validade, situacao, politica ou procedimento. Nunca escolha, confirme, aprove, libere ou altere uma solicitacao.",
  "A escolha e a confirmacao sao feitas por cartoes e botoes fora da IA. Se houver uma selecao aguardando confirmacao, uma mudanca de assunto nao confirma nem cancela essa selecao.",
  "Responda em portugues brasileiro, em no maximo 3 frases curtas, sem markdown.",
  "Retorne SOMENTE JSON valido neste formato: {\"intent\":\"greeting|thanks|certificate_search|clarify|pc_support|change_subject|other\",\"reply\":\"...\",\"query\":\"...\"}.",
  "Use intent certificate_search somente quando a pessoa indicar empresa ou certificado. Em query coloque apenas o texto para pesquisar; caso contrario use query vazia."
].join(" ");

function send(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "http://127.0.0.1:5174",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Luca-Chat"
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) reject(new Error("payload_too_large")); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("invalid_json")); } });
    req.on("error", reject);
  });
}

function normalizeSessionId(value) {
  const sessionId = String(value || "");
  return /^[A-Za-z0-9_-]{8,80}$/.test(sessionId) ? sessionId : null;
}

function parseConversationResponse(value) {
  const raw = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("invalid_model_json");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  const intents = new Set(["greeting", "thanks", "certificate_search", "clarify", "pc_support", "change_subject", "other"]);
  const fallbackReplies = {
    greeting: "Olá! Eu sou o Luca, assistente do Escritório Vavá. Qual empresa ou certificado você procura?",
    thanks: "Por nada! Se precisar de um certificado, e so me dizer a empresa.",
    certificate_search: "Vou procurar esse certificado para voce.",
    clarify: "Qual empresa ou certificado voce procura?",
    pc_support: "Para problemas no computador, procure o Henrique do TI.",
    change_subject: "A mudanca de assunto nao confirma nem cancela a solicitacao.",
    other: "Posso ajudar com solicitacoes de certificados."
  };
  const intent = typeof parsed.intent === "string" ? parsed.intent.split("|")[0].trim() : "";
  if (!intents.has(intent)) throw new Error("invalid_model_response");
  return {
    intent,
    reply: typeof parsed.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : fallbackReplies[intent],
    query: intent === "certificate_search" && typeof parsed.query === "string" ? parsed.query.trim().slice(0, 160) : ""
  };
}

function isComputerConcern(value) {
  return /\b(?:computador|pc|notebook|windows|impressora|outlook|internet|dns|senha|erro tecnico|problema tecnico)\b/i.test(value);
}

function isCasualConversation(value) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[!?.,;:]+/g, " ").replace(/\s+/g, " ").trim();
  return /^(?:oi|ola|bom dia|boa tarde|boa noite)(?: luca)?(?: tudo bem)?$/.test(normalized) || /^(?:obrigado|obrigada|valeu|agradeco)$/.test(normalized) || /^(?:quem e voce|como voce se chama)$/.test(normalized);
}

function hasIdentifiableCatalogQuery(value) {
  const normalized = String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return false;
  if (/\d{6,}/.test(normalized.replace(/\D/g, ""))) return true;
  const meaningful = normalized.split(" ").filter((part) => !["certificado", "certificados", "empresa", "documento", "cnpj", "cpf", "de", "da", "do", "para", "por", "favor", "quero", "preciso"].includes(part));
  return meaningful.some((part) => /[a-z]{3,}/.test(part));
}

function createGenerationQueue(maxQueue = MAX_QUEUE) {
  let active = false;
  const pending = [];
  async function pump() {
    if (active || pending.length === 0) return;
    active = true;
    const item = pending.shift();
    try { item.resolve(await item.task()); } catch (error) { item.reject(error); }
    finally { active = false; pump(); }
  }
  return {
    run(task) {
      if (pending.length >= maxQueue) return Promise.reject(Object.assign(new Error("conversation_queue_full"), { status: 429 }));
      return new Promise((resolve, reject) => { pending.push({ task, resolve, reject }); pump(); });
    }
  };
}

function createConversationService({ fetchImpl = fetch, ollamaUrl = OLLAMA_URL, model = OLLAMA_MODEL, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const queue = createGenerationQueue();
  async function generate(history, phase) {
    previewStats.graniteCalls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(ollamaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          format: "json",
          messages: [{ role: "system", content: `${SYSTEM_PROMPT} Estado controlado atual: ${phase}.` }, ...history],
          options: { num_ctx: 2048, temperature: 0, num_predict: 128 },
          keep_alive: "5m"
        })
      });
      if (!response.ok) throw Object.assign(new Error("ollama_unavailable"), { status: 503 });
      const body = await response.json();
      return { ...parseConversationResponse(body.message?.content), source: "granite", model };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    converse(sessionId, message, phase) {
      previewStats.conversationCalls += 1;
      const previous = conversations.get(sessionId) || [];
      const history = previous.slice(-MAX_HISTORY);
      if (isComputerConcern(message)) {
        const result = { intent: "pc_support", reply: "Para problemas no computador, procure o Henrique do TI.", query: "" };
        conversations.set(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: result.reply }].slice(-MAX_HISTORY));
        return Promise.resolve(result);
      }
      return queue.run(async () => {
        let result = await generate([...history, { role: "user", content: message }], phase);
        if (isCasualConversation(message)) {
          result = { ...result, intent: "greeting", query: "" };
        }
        if (result.intent !== "certificate_search" || !hasIdentifiableCatalogQuery(result.query)) result.query = "";
        const next = [...history, { role: "user", content: message }, { role: "assistant", content: result.reply }].slice(-MAX_HISTORY);
        conversations.set(sessionId, next);
        return result;
      });
    }
  };
}

function searchCatalog(query) {
  const value = String(query.get("q") || "").toLowerCase();
  if (value.includes("nenhum")) return [];
  if (value.includes("multi")) return certificates;
  if (value.includes("beta")) return [certificates[1]];
  if (value.includes("alfa")) return [certificates[0]];
  return [];
}

function createPreviewServer({ conversationService = createConversationService() } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/api/portal/session" && ["GET", "POST"].includes(req.method)) {
      return send(res, 200, { hostname: "PC-SINTETICO", usuarioWindows: "usuario.teste", expiresAt: new Date(Date.now() + 900000).toISOString(), identificacao: "Sessao sintetica isolada para previa." });
    }
    if (url.pathname === "/api/auth/me" && req.method === "GET") return send(res, 200, { username: "usuario.teste", role: "VIEWER" });
    if (url.pathname === "/api/portal/browser-notifications/status" && req.method === "GET") return send(res, 200, { enabled: false });
    if (url.pathname === "/api/portal/luca/conversa" && req.method === "POST") {
      try {
        const input = await readJson(req);
        const sessionId = normalizeSessionId(input.sessionId);
        const message = String(input.message || "").trim().replace(/\s+/g, " ");
        if (!sessionId || !message || message.length > 500) return send(res, 400, { erro: "Sessao ou mensagem invalida." });
        const result = await conversationService.converse(sessionId, message, String(input.phase || "waiting"));
        return send(res, 200, result);
      } catch (error) {
        return send(res, error.status || 503, { erro: "O Luca esta indisponivel nesta previa." });
      }
    }
    if (url.pathname === "/api/preview/stats" && req.method === "GET") return send(res, 200, previewStats);
    if (url.pathname === "/api/portal/certificados" && req.method === "GET") {
      previewStats.catalogCalls += 1;
      if (req.headers["x-luca-chat"] === "true") previewStats.chatCatalogCalls += 1;
      const items = searchCatalog(url.searchParams);
      return send(res, 200, { items, total: items.length, page: 1, pageSize: 5, totalPages: 1 });
    }
    if (url.pathname === "/api/portal/solicitacoes" && req.method === "GET") return send(res, 200, { items: requests, total: requests.length, page: 1, pageSize: 100, totalPages: 1 });
    if (url.pathname === "/api/portal/solicitacoes" && req.method === "POST") {
      try {
        previewStats.createCalls += 1;
        if (req.headers["x-luca-chat"] === "true") previewStats.chatCreateCalls += 1;
        const input = await readJson(req);
        if (requests.some((item) => item.certificado.id === input.certificadoId && item.estado === "PENDENTE")) return send(res, 409, { erro: "Ja existe uma solicitacao pendente deste certificado para esta estacao." });
        const certificado = certificates.find((item) => item.id === input.certificadoId);
        if (!certificado) return send(res, 404, { erro: "Certificado nao encontrado." });
        const request = { id: requests.length + 1, protocolo: `SINT-${requests.length + 1}`, estado: "PENDENTE", motivo: input.motivo || null, certificado };
        requests.push(request);
        return send(res, 201, request);
      } catch { return send(res, 400, { erro: "Pedido invalido." }); }
    }
    return send(res, 404, { erro: "Mock endpoint not found" });
  });
}

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, "127.0.0.1", () => console.log(`Previa sintetica em http://127.0.0.1:${PORT}`));
}

module.exports = { createConversationService, createPreviewServer, parseConversationResponse, SYSTEM_PROMPT };
