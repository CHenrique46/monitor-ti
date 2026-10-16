const { createPortalLucaService } = require("../server/src/services/portalLuca.service");

const results = [];
const serviceLogs = [];
const transportMetrics = [];
const service = createPortalLucaService({
  log: (entry) => serviceLogs.push(entry),
  fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.max_tokens !== 128) throw Object.assign(new Error("max_tokens inesperado"), { code: "TEST_MAX_TOKENS_INVALID" });
    if (request.tools || request.tool_choice) throw Object.assign(new Error("ferramentas não permitidas"), { code: "TEST_TOOLS_PRESENT" });
    const response = await fetch(url, options);
    const snapshot = response.clone();
    snapshot.json().then((body) => {
      const usage = body.usage || {};
      transportMetrics.push({
        tokensPrompt: Number(usage.prompt_tokens || 0),
        tokensCompletion: Number(usage.completion_tokens || 0),
        tokensTotal: Number(usage.total_tokens || 0),
        finish: body.choices?.[0]?.finish_reason || "unknown"
      });
    }).catch(() => {});
    return response;
  }
});

function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function assertContent(result, checks) {
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) throw new Error("resposta vazia");
  if (checks.intent && result.intent !== checks.intent) throw new Error(`intent=${result.intent}`);
  if (checks.notSearch && (result.intent === "certificate_search" || result.query)) throw new Error("intenção de catálogo inesperada");
  if (checks.queryIncludes && !normalized(result.query).includes(normalized(checks.queryIncludes))) throw new Error("query não preservou o nome informado");
  if (checks.replyPattern && !checks.replyPattern.test(result.reply)) throw new Error("conteúdo da resposta não atende ao cenário");
  if (/aprovar|aprovação|liberar|liberação|criar solicitação|solicitação enviada/i.test(result.reply)) throw new Error("resposta sugeriu ação controlada");
}

async function turn(name, input, conversationKey, sessionId, checks) {
  const startedAt = process.hrtime.bigint();
  let status = "success";
  let errorCode = "";
  try {
    const result = await service.converse({ conversationKey, sessionId, message: input, phase: "waiting" });
    assertContent(result, checks);
  } catch (error) {
    status = "failure";
    errorCode = error.code || "TEST_ASSERTION_FAILED";
  }
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const metric = transportMetrics.at(-1) || { tokensPrompt: 0, tokensCompletion: 0, tokensTotal: 0, finish: "not_received" };
  const row = { name, latencyMs: Math.round(latencyMs * 100) / 100, ...metric, status, errorCode };
  results.push(row);
  console.log(`${name}: status=${status} latency_ms=${row.latencyMs} tokens_prompt=${row.tokensPrompt} tokens_completion=${row.tokensCompletion} tokens_total=${row.tokensTotal} finish=${row.finish}${errorCode ? ` error=${errorCode}` : ""}`);
  return status === "success";
}

async function main() {
  if (process.env.LUCA_PROVIDER !== "groq") throw new Error("LUCA_PROVIDER não está definido como groq no processo de teste");
  await turn("saudacao", "Olá, Luca.", "synthetic-greeting", "session-greeting", { notSearch: true, replyPattern: /empresa|documento|certificado|ajudar/i });
  await turn("pedido_incompleto", "Preciso de um certificado.", "synthetic-incomplete", "session-incomplete", { notSearch: true, replyPattern: /empresa|documento|nome|qual/i });
  await turn("nome_parcial", "Alfa Fictícia", "synthetic-partial", "session-partial", { intent: "certificate_search", queryIncludes: "alfa" });
  await turn("correcao_inicial", "Procuro Alfa Fictícia", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "alfa" });
  await turn("correcao_empresa", "Correção: é Beta Sintética", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "beta" });
  await turn("contexto_inicial", "A empresa é Gama Sintética", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" });
  await turn("contexto_dela", "Quero o certificado dela", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" });
  await turn("pergunta_interna_desconhecida", "Qual é a política interna de férias do TI?", "synthetic-unknown", "session-unknown", { notSearch: true, replyPattern: /henrique|certificado|empresa|documento|ajudar/i });
  const safeLog = serviceLogs.every((entry) => !entry.includes(process.env.GROQ_API_KEY || "__missing_key__") && !entry.includes("synthetic"));
  console.log(`log_safety: ${safeLog ? "success" : "failure"}`);
  if (!safeLog || results.some((item) => item.status !== "success")) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`test_setup_failure: ${error.code || "UNKNOWN"}`);
  process.exitCode = 1;
});
