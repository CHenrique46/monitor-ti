const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/api/chat";
const DEFAULT_MODEL = "granite3.3:2b";
const DEFAULT_GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
const MAX_HISTORY = 8;
const MAX_QUEUE = 4;
const MAX_MESSAGE_LENGTH = 500;
const MAX_QUERY_LENGTH = 160;
const REQUEST_TIMEOUT_MS = 15000;
const CONVERSATION_TTL_MS = 15 * 60 * 1000;
const MAX_CONVERSATIONS = 256;
const SAFE_SEARCH_CLARIFICATION = "Informe o nome ou documento da empresa para eu iniciar a pesquisa.";
const SEARCH_CLAIM_PATTERN = /encontrei|localizei|vou (?:pesquisar|consultar)|pesquisa realizada|certificado encontrado/i;
const GENERIC_WORDS = new Set(["a", "o", "as", "os", "um", "uma", "de", "da", "do", "das", "dos", "para", "por", "favor", "quero", "preciso", "necessito", "certificado", "certificados", "empresa", "documento", "cnpj", "cpf", "qual", "que", "dela", "dele", "esse", "essa", "isso"]);

const SYSTEM_PROMPT = [
  "Você é Luca, assistente do portal de certificados digitais.",
  "Responda em português brasileiro, em no máximo 3 frases curtas, sem markdown.",
  "O atendimento já está no portal de certificados digitais.",
  "Nome completo ou parcial da empresa basta para iniciar a pesquisa.",
  "Documento significa CPF ou CNPJ e é uma alternativa ao nome, não um dado obrigatório.",
  "Não pergunte tipo de certificado ou documento antes da busca quando houver empresa identificável.",
  "Uma correção de empresa substitui a anterior; a busca controlada resolve a ambiguidade pelos resultados reais.",
  "Nunca invente catálogo, validade, situação, política ou procedimento.",
  "Nunca escolha, confirme, aprove, libere, altere ou crie uma solicitação.",
  "Para perguntas sem informação disponível, admita claramente que não tem essa informação, sem inventar procedimento.",
  "Retorne SOMENTE JSON com reply, intent e query. certificate_search exige query identificável; conversation e clarification devem usar query vazia.",
  "Use certificate_search para pedido de busca ou correção com empresa ou documento identificável; caso contrário use clarification ou conversation conforme o contexto."
].join(" ");

function makeError(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function validateLoopbackUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || DEFAULT_OLLAMA_URL)); } catch { throw makeError("LUCA_OLLAMA_URL_INVALID", "O Luca está indisponível."); }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(parsed.hostname)) throw makeError("LUCA_OLLAMA_URL_INVALID", "O Luca está indisponível.");
  return parsed.toString();
}

function normalizeProvider(value) {
  const provider = String(value || "ollama").trim().toLowerCase();
  if (!["ollama", "groq"].includes(provider)) throw makeError("LUCA_PROVIDER_INVALID", "O provedor do Luca é inválido.", 503);
  return provider;
}

function normalizeSessionId(value) {
  const id = String(value || "");
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : null;
}

function sanitizeMessage(value) {
  return String(value || "").trim().replace(/\s+/g, " ")
    .replace(/(?:senha|password|pass|token|secret)\s*[:=]?\s*[^\s,;]+/gi, "[credencial omitida]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s]+/g, "[caminho omitido]")
    .replace(/\S+\.(?:pfx|p12)\b/gi, "[certificado omitido]")
    .slice(0, MAX_MESSAGE_LENGTH);
}

function normalizeResponse(value) {
  const raw = String(value || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) { try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch { parsed = null; } }
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.reply !== "string" || typeof parsed.intent !== "string" || typeof parsed.query !== "string") throw makeError("LUCA_RESPONSE_INVALID", "A resposta do Luca não pôde ser validada.");
  const intent = parsed.intent === "certificate_search" ? "certificate_search" : parsed.intent === "clarification" ? "clarification" : "conversation";
  if (intent === "certificate_search" && !String(parsed.query || "").trim()) return { intent: "clarification", reply: SAFE_SEARCH_CLARIFICATION, query: "" };
  const reply = String(parsed.reply || parsed.message || "").trim().slice(0, 500);
  if (intent !== "certificate_search" && String(parsed.query || "").trim() && SEARCH_CLAIM_PATTERN.test(reply)) return { intent: "clarification", reply: SAFE_SEARCH_CLARIFICATION, query: "" };
  return { intent, reply, query: intent === "certificate_search" ? String(parsed.query || "").trim().slice(0, MAX_QUERY_LENGTH) : "" };
}

function hasCatalogSignal(query, userMessages) {
  const normalizedQuery = String(query || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const queryDigits = normalizedQuery.replace(/\D/g, "");
  const source = userMessages.join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (queryDigits.length >= 6) return source.replace(/\D/g, "").includes(queryDigits);
  return normalizedQuery.split(/\s+/).filter((part) => part.length >= 3 && !GENERIC_WORDS.has(part)).some((part) => source.includes(part));
}

function hasOnlyUserTerms(query, userMessages) {
  const normalizedQuery = String(query || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const source = userMessages.join(" ").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const terms = normalizedQuery.split(/[^a-z0-9]+/).filter((part) => part.length >= 3 && !GENERIC_WORDS.has(part));
  return terms.length > 0 && terms.every((term) => source.includes(term));
}

function createQueue(maxQueue = MAX_QUEUE) {
  let active = false;
  const pending = [];
  async function pump() {
    if (active || pending.length === 0) return;
    active = true;
    const item = pending.shift();
    try { item.resolve(await item.task()); } catch (error) { item.reject(error); }
    finally { active = false; pump(); }
  }
  return { run(task) { if (pending.length >= maxQueue) return Promise.reject(makeError("LUCA_QUEUE_FULL", "O Luca está ocupado. Tente novamente em instantes.", 429)); return new Promise((resolve, reject) => { pending.push({ task, resolve, reject }); pump(); }); } };
}

function createPortalLucaService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  provider: configuredProvider = process.env.LUCA_PROVIDER || "ollama",
  ollamaUrl = process.env.LUCA_OLLAMA_URL || DEFAULT_OLLAMA_URL,
  model = process.env.LUCA_OLLAMA_MODEL || DEFAULT_MODEL,
  groqUrl = DEFAULT_GROQ_URL,
  groqModel = process.env.LUCA_GROQ_MODEL || DEFAULT_GROQ_MODEL,
  groqApiKey = process.env.GROQ_API_KEY || "",
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = () => {}
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Fetch indisponível para o Luca.");
  const provider = normalizeProvider(configuredProvider);
  if (provider === "groq" && !String(groqApiKey).trim()) throw makeError("LUCA_GROQ_NOT_CONFIGURED", "O provedor Groq não está configurado.", 503);
  const endpoint = provider === "ollama" ? validateLoopbackUrl(ollamaUrl) : groqUrl;
  const activeModel = provider === "groq" ? String(groqModel).trim() : String(model).trim();
  const conversations = new Map();
  const queue = createQueue();

  function cleanup() {
    const cutoff = now() - CONVERSATION_TTL_MS;
    for (const [key, item] of conversations) if (item.updatedAt <= cutoff) conversations.delete(key);
    while (conversations.size > MAX_CONVERSATIONS) conversations.delete(conversations.keys().next().value);
  }

  async function generate(history, phase) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    log(`luca_request_start provider=${provider} model=${activeModel}`);
    try {
      const messages = [{ role: "system", content: `${SYSTEM_PROMPT} Fase: ${phase}.` }, ...history];
      const request = provider === "groq"
        ? { model: activeModel, messages, temperature: 0, max_tokens: 512, reasoning_effort: "low", response_format: { type: "json_object" } }
        : { model: activeModel, stream: false, format: { type: "object", properties: { reply: { type: "string" }, intent: { type: "string" }, query: { type: "string" } }, required: ["reply", "intent", "query"] }, messages, options: { num_ctx: 2048, temperature: 0, num_predict: 128 }, keep_alive: "5m" };
      const headers = { "Content-Type": "application/json" };
      if (provider === "groq") headers.Authorization = `Bearer ${String(groqApiKey).trim()}`;
      const response = await fetchImpl(endpoint, { method: "POST", headers, signal: controller.signal, body: JSON.stringify(request) });
      log(`luca_response provider=${provider} model=${activeModel} http_status=${response.status}`);
      if (response.status === 429) throw makeError("LUCA_RATE_LIMITED", "O Luca atingiu o limite temporário de consultas.", 429);
      if (!response.ok) throw makeError(provider === "groq" ? "LUCA_GROQ_UNAVAILABLE" : "LUCA_OLLAMA_UNAVAILABLE", "O Luca está indisponível.");
      const body = await response.json();
      const choice = provider === "groq" ? body.choices?.[0] : null;
      if (provider === "groq" && choice?.finish_reason === "length") {
        log(`luca_validation provider=${provider} model=${activeModel} validation=truncated finish=length`);
        throw makeError("LUCA_RESPONSE_TRUNCATED", "A resposta do Luca foi interrompida.");
      }
      const content = provider === "groq" ? choice?.message?.content : body.message?.content;
      const result = normalizeResponse(content);
      log(`luca_validation provider=${provider} model=${activeModel} validation=ok intent=${result.intent} query_present=${Boolean(result.query)} finish=${choice?.finish_reason || "complete"}`);
      const usage = provider === "groq" ? body.usage || {} : {};
      log(`luca_request_ok provider=${provider} model=${activeModel} duration_ms=${Date.now() - startedAt} tokens_prompt=${Number(usage.prompt_tokens || 0)} tokens_completion=${Number(usage.completion_tokens || 0)} tokens_total=${Number(usage.total_tokens || 0)} finish=${choice?.finish_reason || "complete"}`);
      return result;
    } catch (error) {
      const failure = error.name === "AbortError" ? makeError("LUCA_TIMEOUT", "O Luca demorou para responder.") : error.code ? error : makeError(provider === "groq" ? "LUCA_GROQ_UNAVAILABLE" : "LUCA_OLLAMA_UNAVAILABLE", "O Luca está indisponível.");
      log(`luca_request_error provider=${provider} model=${activeModel} code=${failure.code} stage=${error.code === "LUCA_RESPONSE_INVALID" ? "parser" : error.code === "LUCA_RESPONSE_TRUNCATED" ? "truncation" : error.name === "AbortError" ? "timeout" : "transport"} duration_ms=${Date.now() - startedAt}`);
      throw failure;
    } finally { clearTimeout(timer); }
  }

  return {
    async converse({ conversationKey, sessionId, message, phase = "waiting" }) {
      const id = normalizeSessionId(sessionId);
      const sanitized = sanitizeMessage(message);
      if (!conversationKey || !id || !sanitized) throw makeError("LUCA_INPUT_INVALID", "Mensagem inválida para o Luca.", 400);
      cleanup();
      return queue.run(async () => {
        const key = `${conversationKey}:${id}`;
        const current = conversations.get(key) || { history: [], updatedAt: now() };
        const userMessages = current.history.filter((item) => item.role === "user").map((item) => item.content).concat(sanitized);
        const result = await generate([...current.history.slice(-MAX_HISTORY), { role: "user", content: sanitized }], String(phase).slice(0, 40));
        if (result.intent === "certificate_search" && (!hasCatalogSignal(result.query, userMessages) || !hasOnlyUserTerms(result.query, userMessages))) { result.intent = "clarification"; result.query = ""; result.reply = SAFE_SEARCH_CLARIFICATION; }
        if (result.intent !== "certificate_search") result.query = "";
        conversations.set(key, { history: [...current.history, { role: "user", content: sanitized }, { role: "assistant", content: result.reply }].slice(-MAX_HISTORY), updatedAt: now() });
         return { ...result, source: provider, model: activeModel };
      });
    },
    _conversations: conversations
  };
}

module.exports = { createPortalLucaService, sanitizeMessage, validateLoopbackUrl, normalizeResponse, normalizeProvider, hasCatalogSignal, hasOnlyUserTerms };
