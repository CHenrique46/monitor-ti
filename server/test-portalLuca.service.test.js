const test = require("node:test");
const assert = require("node:assert/strict");
const { createPortalLucaService, sanitizeMessage, validateLoopbackUrl, normalizeResponse, normalizeProvider, hasOnlyUserTerms } = require("./src/services/portalLuca.service");

function response(content, ok = true) {
  return { ok, json: async () => ({ message: { content } }) };
}

function groqResponse(content, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ choices: [{ message: { content } }] }) };
}

test("accepts only Ollama loopback endpoints", () => {
  assert.equal(validateLoopbackUrl("http://127.0.0.1:11434/api/chat"), "http://127.0.0.1:11434/api/chat");
  assert.throws(() => validateLoopbackUrl("http://192.168.40.133:11434/api/chat"), { code: "LUCA_OLLAMA_URL_INVALID" });
});

test("selects Groq explicitly and sends only the private backend credential", async () => {
  let request;
  const logs = [];
  const service = createPortalLucaService({
    provider: "groq",
    groqApiKey: "synthetic-key-not-for-production",
    fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return groqResponse('{"reply":"Qual empresa você procura?","intent":"clarification","query":""}'); },
    log: (entry) => logs.push(entry)
  });
  const result = await service.converse({ conversationKey: "computer-groq", sessionId: "session-groq", message: "Oi", phase: "waiting" });
  assert.equal(normalizeProvider("groq"), "groq");
  assert.equal(result.source, "groq");
  assert.equal(result.model, "openai/gpt-oss-20b");
  assert.equal(request.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer synthetic-key-not-for-production");
  assert.equal(request.body.model, "openai/gpt-oss-20b");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal("tools" in request.body, false);
  assert.equal(logs.some((entry) => entry.includes("synthetic-key-not-for-production")), false);
  assert.equal(logs.some((entry) => entry.includes("Qual empresa")), false);
});

test("does not start Groq without a backend key", () => {
  assert.throws(() => createPortalLucaService({ provider: "groq", groqApiKey: "" }), { code: "LUCA_GROQ_NOT_CONFIGURED" });
});

test("normalizes model output and never sends sensitive paths or credentials", async () => {
  let request;
  const service = createPortalLucaService({ fetchImpl: async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return response('{"reply":"Informe a empresa.","intent":"clarification","query":""}'); } });
  const result = await service.converse({ conversationKey: "7", sessionId: "session-1", message: "Preciso do arquivo C:\\segredo\\cliente.pfx e senha: abc123", phase: "waiting" });
  assert.equal(result.intent, "clarification");
  assert.equal(request.url, "http://127.0.0.1:11434/api/chat");
  const serialized = JSON.stringify(request.body);
  assert.equal(serialized.includes("cliente.pfx"), false);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(JSON.stringify(request.body.messages.filter((item) => item.role === "user")).includes("catalogo"), false);
});

test("isolates histories by portal station and conversation", async () => {
  const seen = [];
  const service = createPortalLucaService({ fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); seen.push(body.messages); return response('{"reply":"ok","intent":"conversation","query":""}'); } });
  await service.converse({ conversationKey: "computer-a", sessionId: "session-1", message: "Oi empresa Alfa", phase: "waiting" });
  await service.converse({ conversationKey: "computer-b", sessionId: "session-1", message: "Oi empresa Beta", phase: "waiting" });
  assert.equal(seen[1].some((item) => item.content?.includes("Alfa")), false);
});

test("forces unverifiable catalog queries back to clarification", async () => {
  const service = createPortalLucaService({ fetchImpl: async () => response('{"reply":"Encontrei","intent":"certificate_search","query":"Empresa Inventada"}') });
  const result = await service.converse({ conversationKey: "7", sessionId: "session-2", message: "Preciso de um certificado", phase: "waiting" });
  assert.equal(result.intent, "clarification");
  assert.equal(result.query, "");
});

test("accepts partial names, keeps correction context, and resolves pronoun context without inventing names", async () => {
  const seen = [];
  const service = createPortalLucaService({ provider: "groq", groqApiKey: "synthetic", fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.messages);
    const user = body.messages.filter((item) => item.role === "user").at(-1).content.toLowerCase();
    if (user.includes("beta")) return groqResponse('{"reply":"Vou consultar Beta.","intent":"certificate_search","query":"Beta"}');
    if (user.includes("dela")) return groqResponse('{"reply":"Vou manter a empresa anterior.","intent":"certificate_search","query":"Alfa"}');
    return groqResponse('{"reply":"Encontrei Alfa.","intent":"certificate_search","query":"Alfa"}');
  }});
  assert.equal((await service.converse({ conversationKey: "computer-context", sessionId: "session-context", message: "alfa", phase: "waiting" })).query, "Alfa");
  assert.equal((await service.converse({ conversationKey: "computer-context", sessionId: "session-context", message: "não, empresa beta", phase: "confirming" })).query, "Beta");
  const pronoun = await service.converse({ conversationKey: "computer-context", sessionId: "session-context", message: "o certificado dela", phase: "waiting" });
  assert.equal(pronoun.query, "Alfa");
  assert.equal(seen[1].some((item) => item.role === "user" && item.content.includes("alfa")), true);
  assert.equal(hasOnlyUserTerms("Alfa Serviços", ["alfa"]), false);
});

test("does not retry or change provider after Groq rate limiting", async () => {
  let calls = 0;
  const service = createPortalLucaService({ provider: "groq", groqApiKey: "synthetic", fetchImpl: async () => { calls += 1; return groqResponse("limite", 429); } });
  await assert.rejects(() => service.converse({ conversationKey: "computer-rate", sessionId: "session-rate", message: "Oi", phase: "waiting" }), { code: "LUCA_RATE_LIMITED" });
  assert.equal(calls, 1);
});

test("keeps unknown questions in conversation without turning them into catalog searches", async () => {
  const service = createPortalLucaService({ provider: "groq", groqApiKey: "synthetic", fetchImpl: async () => groqResponse('{"reply":"Posso ajudar a localizar certificados.","intent":"conversation","query":"empresa inventada"}') });
  const result = await service.converse({ conversationKey: "computer-unknown", sessionId: "session-unknown", message: "Qual é a política de férias?", phase: "waiting" });
  assert.equal(result.intent, "conversation");
  assert.equal(result.query, "");
});

test("returns timeout as a controlled failure", async () => {
  const service = createPortalLucaService({ timeoutMs: 1, fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) });
  await assert.rejects(() => service.converse({ conversationKey: "7", sessionId: "session-3", message: "Olá", phase: "waiting" }), { code: "LUCA_TIMEOUT" });
});

test("normalizes malformed model output without exposing arbitrary intent", () => {
  assert.deepEqual(normalizeResponse('{"reply":"x","intent":"approve","query":"secret"}'), { intent: "conversation", reply: "x", query: "" });
  assert.equal(sanitizeMessage("senha: segredo").includes("segredo"), false);
});

test("rejects incomplete JSON instead of treating it as a conversation", () => {
  assert.throws(() => normalizeResponse('{"reply":"resposta interrompida"}'), { code: "LUCA_RESPONSE_INVALID" });
});

test("rejects Groq length truncation as a controlled failure", async () => {
  const service = createPortalLucaService({ provider: "groq", groqApiKey: "synthetic", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "{\\\"reply\\\":\\\"interrompido" } }] }) }) });
  await assert.rejects(() => service.converse({ conversationKey: "computer-truncated", sessionId: "session-truncated", message: "Oi", phase: "waiting" }), { code: "LUCA_RESPONSE_TRUNCATED" });
});
