const { createPortalLucaService } = require("../server/src/services/portalLuca.service");

const endpoint = "https://api.groq.com/openai/v1/chat/completions";
const serviceLogs = [];
const transportMetrics = [];
const diagnostic = {
  endpoint,
  node: process.version,
  fetchAvailable: typeof fetch === "function",
  keyPresent: Boolean(process.env.GROQ_API_KEY),
  keyLength: String(process.env.GROQ_API_KEY || "").length,
  keyFormatValid: /^gsk_[A-Za-z0-9_-]{20,}$/.test(String(process.env.GROQ_API_KEY || "")),
  requestFields: [],
  networkClass: "not_started",
  httpStatus: "not_received",
  providerCode: "not_received",
  serviceCode: "not_received",
  lastRequestMessages: [],
  lastModelOutput: null
};

function classifyNetworkError(error) {
  if (error?.name === "AbortError") return "timeout";
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code)) return "dns";
  if (["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(code)) return "tls";
  if (["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) return "connection";
  if (["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)) return "timeout";
  return "local_fetch_error";
}

function safeProviderCode(body) {
  const value = body?.error?.code || body?.error?.type || "unknown";
  return /^[A-Za-z0-9_.-]{1,64}$/.test(String(value)) ? String(value) : "sanitized_provider_error";
}

async function recordResponse(response) {
  diagnostic.networkClass = "https_response";
  diagnostic.httpStatus = response.status;
  const snapshot = response.clone();
  try {
    const body = await snapshot.json();
    diagnostic.providerCode = response.ok ? "none" : safeProviderCode(body);
    diagnostic.lastModelOutput = body.choices?.[0]?.message?.content || null;
    const usage = body.usage || {};
    transportMetrics.push({
      tokensPrompt: Number(usage.prompt_tokens || 0),
      tokensCompletion: Number(usage.completion_tokens || 0),
      tokensTotal: Number(usage.total_tokens || 0),
      finish: body.choices?.[0]?.finish_reason || "unknown"
    });
  } catch {
    diagnostic.providerCode = response.ok ? "none" : "unreadable_provider_error";
  }
}

const service = createPortalLucaService({
  log: (entry) => serviceLogs.push(entry),
  fetchImpl: async (url, options) => {
    try {
      const request = JSON.parse(options.body);
      diagnostic.requestFields = Object.keys(request).sort();
      diagnostic.lastRequestMessages = request.messages;
      if (request.max_tokens !== 512) throw Object.assign(new Error("max_tokens inesperado"), { code: "TEST_MAX_TOKENS_INVALID" });
      if (request.reasoning_effort !== "low") throw Object.assign(new Error("reasoning_effort inesperado"), { code: "TEST_REASONING_EFFORT_INVALID" });
      if (request.response_format?.type !== "json_object") throw Object.assign(new Error("contrato JSON ausente"), { code: "TEST_JSON_CONTRACT_INVALID" });
      if (request.tools || request.tool_choice) throw Object.assign(new Error("ferramentas não permitidas"), { code: "TEST_TOOLS_PRESENT" });
      const response = await fetch(url, options);
      await recordResponse(response);
      return response;
    } catch (error) {
      diagnostic.networkClass = classifyNetworkError(error);
      throw error;
    }
  }
});

function normalized(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function assertContent(result, checks) {
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) throw new Error("resposta_vazia");
  if (checks.intent && result.intent !== checks.intent) throw new Error(`intent_${result.intent}`);
  if (checks.notSearch && (result.intent === "certificate_search" || result.query)) throw new Error("intencao_catalogo_inesperada");
  if (checks.queryIncludes && !normalized(result.query).includes(normalized(checks.queryIncludes))) throw new Error("query_nome_nao_preservado");
  if (checks.replyPattern && !checks.replyPattern.test(result.reply)) throw new Error("conteudo_fora_do_cenario");
  if (checks.admitsUnknown && !/(nao tenho|nao sei|nao possuo|nao disponho|sem informacao)/i.test(normalized(result.reply))) throw new Error("admissao_de_desconhecimento_ausente");
  if (/aprovar|aprovação|liberar|liberação|criar solicitação|solicitação enviada/i.test(result.reply)) throw new Error("resposta_sugeriu_acao_controlada");
}

async function runTurn(name, input, conversationKey, sessionId, checks) {
  const startedAt = process.hrtime.bigint();
  let status = "success";
  let errorCode = "";
  try {
    const result = await service.converse({ conversationKey, sessionId, message: input, phase: "waiting" });
    assertContent(result, checks);
  } catch (error) {
    status = "failure";
    errorCode = error.code || "TEST_ASSERTION_FAILED";
    diagnostic.serviceCode = error.code || "unknown";
  }
  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;
  const metric = transportMetrics.at(-1) || { tokensPrompt: 0, tokensCompletion: 0, tokensTotal: 0, finish: "not_received" };
  console.log(`${name}: status=${status} latency_ms=${latencyMs} tokens_prompt=${metric.tokensPrompt} tokens_completion=${metric.tokensCompletion} tokens_total=${metric.tokensTotal} finish=${metric.finish}${errorCode ? ` error=${errorCode}` : ""}`);
  return status === "success";
}

function classifyFocusedFailure(error, result, checks, requestMessages) {
  if (["LUCA_RESPONSE_INVALID", "LUCA_RESPONSE_TRUNCATED"].includes(error.code)) return "parser";
  if (error.code !== "TEST_ASSERTION_FAILED") return "servico";
  const previousTurns = requestMessages.filter((message) => message.role !== "system").length > 1;
  if (checks.intent && result?.intent !== checks.intent) return previousTurns ? "contexto_ou_modelo" : "modelo";
  if (checks.queryIncludes && !normalized(result?.query).includes(normalized(checks.queryIncludes))) return previousTurns ? "contexto_ou_modelo" : "modelo";
  if (checks.notSearch && (result?.intent === "certificate_search" || result?.query)) return "modelo";
  if (checks.replyPattern && result?.reply && !checks.replyPattern.test(result.reply)) return "teste_excessivamente_rigido_candidato";
  return "teste_excessivamente_rigido_ou_resposta_incompleta";
}

async function runFocusedTurn(name, input, conversationKey, sessionId, checks) {
  const startedAt = process.hrtime.bigint();
  let result = null;
  let failure = null;
  try {
    result = await service.converse({ conversationKey, sessionId, message: input, phase: "waiting" });
    assertContent(result, checks);
  } catch (error) {
    failure = error;
    if (!failure.code) failure.code = "TEST_ASSERTION_FAILED";
    diagnostic.serviceCode = error.code || "unknown";
  }
  const latencyMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e4) / 100;
  console.log(`focused_case=${name}`);
  console.log(`message=${JSON.stringify(input)}`);
  console.log(`context=${JSON.stringify(diagnostic.lastRequestMessages)}`);
  const sentUserText = diagnostic.lastRequestMessages.filter((message) => message.role === "user").at(-1)?.content || "";
  console.log(`utf8_integrity=${sentUserText === input ? "pass" : "check_required"} codepoints=${Array.from(sentUserText).filter((char) => "íçã".includes(char)).map((char) => `${char}:${char.codePointAt(0).toString(16)}`).join(",") || "none"}`);
  console.log(`model_response=${JSON.stringify(diagnostic.lastModelOutput)}`);
  console.log(`interpreted=${JSON.stringify(result ? { intent: result.intent || null, query: result.query || null, reply: result.reply || null } : null)}`);
  console.log(`expected=${JSON.stringify(checks)}`);
  console.log(`outcome=${failure ? "failure" : "success"} failure_reason=${failure ? JSON.stringify(failure.message) : "none"} classification=${failure ? classifyFocusedFailure(failure, result, checks, diagnostic.lastRequestMessages) : "none"} latency_ms=${latencyMs}`);
  return !failure;
}

async function runBattery() {
  const results = [];
  results.push(await runTurn("saudacao", "Olá, Luca.", "synthetic-greeting", "session-greeting", { notSearch: true, replyPattern: /empresa|documento|certificado|ajudar/i }));
  results.push(await runTurn("pedido_incompleto", "Preciso de um certificado.", "synthetic-incomplete", "session-incomplete", { notSearch: true, replyPattern: /empresa|documento|nome|qual/i }));
  results.push(await runTurn("nome_parcial", "Alfa Fictícia", "synthetic-partial", "session-partial", { intent: "certificate_search", queryIncludes: "alfa" }));
  results.push(await runTurn("correcao_inicial", "Procuro Alfa Fictícia", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "alfa" }));
  results.push(await runTurn("correcao_empresa", "Correção: é Beta Sintética", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "beta" }));
  results.push(await runTurn("contexto_inicial", "A empresa é Gama Sintética", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" }));
  results.push(await runTurn("contexto_dela", "Quero o certificado dela", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" }));
  results.push(await runTurn("pergunta_interna_desconhecida", "Qual é a política interna de férias do TI?", "synthetic-unknown", "session-unknown", { notSearch: true, admitsUnknown: true }));
  return results.every(Boolean);
}

async function runFocusedDiagnostics() {
  const results = [];
  results.push(await runFocusedTurn("busca_inicial", "Procuro Alfa Fictícia", "synthetic-search", "session-search", { intent: "certificate_search", queryIncludes: "alfa" }));
  results.push(await runFocusedTurn("correcao_inicial", "Procuro Alfa Fictícia", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "alfa" }));
  results.push(await runFocusedTurn("correcao_empresa", "Correção: é Beta Sintética", "synthetic-correction", "session-correction", { intent: "certificate_search", queryIncludes: "beta" }));
  results.push(await runFocusedTurn("contexto_inicial", "A empresa é Gama Sintética", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" }));
  results.push(await runFocusedTurn("contexto_dela", "Quero o certificado dela", "synthetic-pronoun", "session-pronoun", { intent: "certificate_search", queryIncludes: "gama" }));
  results.push(await runFocusedTurn("pergunta_interna_desconhecida", "Qual é a política interna de férias do TI?", "synthetic-unknown", "session-unknown", { notSearch: true, admitsUnknown: true }));
  return results.every(Boolean);
}

async function main() {
  if (process.env.LUCA_PROVIDER !== "groq") throw Object.assign(new Error("LUCA_PROVIDER ausente"), { code: "TEST_PROVIDER_INVALID" });
  console.log(`diagnostic: node=${diagnostic.node} fetch=${diagnostic.fetchAvailable} key_present=${diagnostic.keyPresent} key_length=${diagnostic.keyLength} key_format_valid=${diagnostic.keyFormatValid}`);
  console.log(`diagnostic: endpoint=${diagnostic.endpoint} request_fields=${diagnostic.requestFields.join(",") || "pending"} max_tokens_expected=512 reasoning_effort=low response_format=json_object`);
  if (!diagnostic.keyPresent || !diagnostic.keyFormatValid || !diagnostic.fetchAvailable) {
    console.log("diagnostic_result: network=not_started http_status=not_started provider_code=not_started service_code=local_configuration_error");
    process.exitCode = 1;
    return;
  }
  const focusedOnly = process.env.LUCA_GROQ_FOCUSED_CASES === "true";
  const diagnosticSuccess = focusedOnly || await runTurn("diagnostico_unico", "Olá. Procuro Alfa Fictícia.", "synthetic-diagnostic", "session-diagnostic", { intent: "certificate_search", queryIncludes: "alfa" });
  if (focusedOnly) {
    process.exitCode = (await runFocusedDiagnostics()) ? 0 : 1;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  console.log(`diagnostic_result: network=${diagnostic.networkClass} http_status=${diagnostic.httpStatus} provider_code=${diagnostic.providerCode} service_code=${diagnostic.serviceCode} request_fields=${diagnostic.requestFields.join(",") || "none"}`);
  const safeLog = serviceLogs.every((entry) => !entry.includes(process.env.GROQ_API_KEY || "__missing_key__") && !entry.includes("synthetic"));
  console.log(`log_safety: ${safeLog ? "success" : "failure"}`);
  if (!diagnosticSuccess || !safeLog) { process.exitCode = 1; return; }
  console.log("diagnostic_success: repeating synthetic battery");
  if (!(await runBattery())) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`test_setup_failure: ${error.code || "UNKNOWN"}`);
  process.exitCode = 1;
});
