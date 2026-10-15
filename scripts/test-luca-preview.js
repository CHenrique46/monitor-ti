const assert = require("assert");
const http = require("http");
const { createConversationService, createPreviewServer } = require("./preview-certificate-chat");

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : null;
    const req = http.request({ hostname: "127.0.0.1", port, path, method: options.method || "GET", headers: { "Content-Type": "application/json", ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : {} }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const server = createPreviewServer({ conversationService: createConversationService() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const sessionA = "session-a-luca";
  const sessionB = "session-b-luca";
  try {
    const beforeCasual = await request(port, "/api/preview/stats");
    const casualMessages = ["Oi, Luca, tudo bem?", "Obrigado", "Quem é você?"];
    for (const message of casualMessages) {
      const casual = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: `${sessionA}-${message.length}`, message, phase: "waiting" } });
      assert.equal(casual.status, 200);
      assert.equal(casual.body.source, "granite");
      assert.equal(casual.body.query, "");
    }
    const afterCasual = await request(port, "/api/preview/stats");
    assert.equal(afterCasual.body.catalogCalls, beforeCasual.body.catalogCalls);
    assert.equal(afterCasual.body.chatCatalogCalls, beforeCasual.body.chatCatalogCalls);
    assert.equal(afterCasual.body.createCalls, beforeCasual.body.createCalls);
    assert.equal(afterCasual.body.chatCreateCalls, beforeCasual.body.chatCreateCalls);

    const greeting = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Oi, tudo bem?", phase: "waiting" } });
    assert.equal(greeting.status, 200);
    assert.ok(greeting.body.reply);

    const clarification = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Quero um certificado, mas ainda nao sei qual empresa", phase: "waiting" } });
    assert.equal(clarification.status, 200);
    assert.ok(clarification.body.reply);

    const search = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Preciso do certificado da Empresa Sintetica Alfa", phase: "waiting" } });
    assert.equal(search.status, 200);
    assert.ok(search.body.reply);
    assert.equal(search.body.intent, "certificate_search");
    assert.ok(search.body.query.toLowerCase().includes("alfa"));

    const catalog = await request(port, "/api/portal/certificados?q=Empresa%20Sintetica%20Alfa");
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.items.length, 1);
    const certificateId = catalog.body.items[0].id;
    const unknownCatalog = await request(port, "/api/portal/certificados?q=texto%20sem%20empresa");
    assert.equal(unknownCatalog.body.items.length, 0);

    const changeSubject = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Na verdade, preciso de outra coisa", phase: "confirming" } });
    assert.equal(changeSubject.status, 200);
    const created = await request(port, "/api/portal/solicitacoes", { method: "POST", body: { certificadoId: certificateId } });
    assert.equal(created.status, 201);
    const duplicate = await request(port, "/api/portal/solicitacoes", { method: "POST", body: { certificadoId: certificateId } });
    assert.equal(duplicate.status, 409);

    const thanks = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Obrigado, Luca", phase: "sent" } });
    assert.equal(thanks.status, 200);
    const pc = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionA, message: "Meu computador está com problema", phase: "waiting" } });
    assert.equal(pc.status, 200);
    assert.ok(pc.body.reply);

    const isolated = await request(port, "/api/portal/luca/conversa", { method: "POST", body: { sessionId: sessionB, message: "Qual empresa você procura?", phase: "waiting" } });
    assert.equal(isolated.status, 200);
    assert.ok(isolated.body.reply);
    assert.ok(!isolated.body.reply.toLowerCase().includes("alfa"));
    console.log("Fluxo sintetico do Luca validado com Granite: saudacao, busca, mudanca de assunto, duplicidade, agradecimento, TI e isolamento de sessoes.");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
