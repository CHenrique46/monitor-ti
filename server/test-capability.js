// Teste isolado da capability "notices" (server-side).
// Não inicia o servidor WebSocket; testa hanya as funções de capacidade e o
// bloqueio de envio de notice_show quando o Agent não está capacitado.
const agentServer = require("./src/ws/agentServer");
const avisosService = require("./src/services/avisos.service");

let pass = 0, fail = 0;
function check(n, c, extra) {
  if (c) { pass++; console.log("PASS " + n); }
  else { fail++; console.log("FAIL " + n + (extra ? " :: " + extra : "")); }
}

(async () => {
  const DEV = "test-device-cap";

  // 1) capability map
  agentServer.setCapabilities(DEV, ["notices"]);
  check("getCapabilities reflete registro", agentServer.getCapabilities(DEV).includes("notices"));
  check("hasCapability true", agentServer.hasCapability(DEV, "notices") === true);
  check("hasCapability false para ausente", agentServer.hasCapability(DEV, "x") === false);
  check("hasCapability false para deviceId sem registro", agentServer.hasCapability("nao-registrado", "notices") === false);

  // 2) atualização via mensagem "capabilities" (sem ws) — testa função subjacente
  agentServer.setCapabilities(DEV, []);
  check("capability limpa para []", agentServer.hasCapability(DEV, "notices") === false);
  agentServer.setCapabilities(DEV, ["notices", "outra"]);
  check("capability reativada", agentServer.hasCapability(DEV, "notices") === true);

  // 3) gating em enviarParaAgente: spin da função de envio
  let sent = [];
  const realSend = agentServer.sendToAgent;
  agentServer.sendToAgent = (deviceId, obj) => { sent.push({ deviceId, obj }); return true; };
  try {
    const entrega = {
      noticeDeliveryId: "uuid-1",
      titulo: "T",
      mensagem: "M",
      nivel: "info",
      criadoEm: new Date()
    };

    // capacitado -> envia
    sent = [];
    let r = await avisosService.enviarParaAgente(DEV, entrega);
    check("envia quando capacitado", r === true && sent.length === 1 && sent[0].obj.type === "notice_show", "sent=" + sent.length);

    // não capacitado -> NÃO envia (retorna false, entrega fica PENDENTE)
    agentServer.setCapabilities(DEV, []);
    sent = [];
    r = await avisosService.enviarParaAgente(DEV, entrega);
    check("NÃO envia quando não capacitado", r === false && sent.length === 0, "sent=" + sent.length);
  } finally {
    agentServer.sendToAgent = realSend;
  }

  // 4) dispositivo nunca registrado não recebe
  agentServer.setCapabilities("outro-device", []);
  sent = [];
  const r2 = await avisosService.enviarParaAgente("outro-device", {
    noticeDeliveryId: "u2", titulo: "T", mensagem: "M", nivel: "info", criadoEm: new Date()
  });
  check("device sem capability não recebe", r2 === false);

  console.log("\nCAPABILITY (server): " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERRO", e); process.exit(1); });
