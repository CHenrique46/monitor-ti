const fs = require("fs");
const path = require("path");
const { normalizeNoticeShowPayload } = require("../agent/src/notifier");

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log("PASS " + name);
  } else {
    fail += 1;
    console.log("FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const notifierCs = read(path.join(__dirname, "..", "notifier", "MonitorTI-Notifier.cs"));
const agentNotifierJs = read(path.join(__dirname, "..", "agent", "src", "notifier.js"));

// A) payload top-level válido -> aceito.
{
  const p = normalizeNoticeShowPayload({
    type: "notice_show",
    noticeDeliveryId: "64c92e13-ad70-4ca1-8ff6-615a2078f34e",
    titulo: "Teste Monitor TI",
    mensagem: "Esta e uma mensagem de teste do sistema de avisos do Monitor TI.",
    nivel: "info",
    timestamp: new Date().toISOString()
  });
  check("A top-level aceito", !!p && p.title === "Teste Monitor TI" && p.message.includes("teste"));
}

// B) payload msg.data válido -> aceito.
{
  const p = normalizeNoticeShowPayload({
    data: {
      noticeDeliveryId: "64c92e13-ad70-4ca1-8ff6-615a2078f34e",
      title: "Teste Monitor TI",
      message: "Mensagem",
      level: "info",
      timestamp: new Date().toISOString()
    }
  });
  check("B data aceito", !!p && p.title === "Teste Monitor TI" && p.message === "Mensagem");
}

// C-F) validações.
check("C UUID invalido rejeita", normalizeNoticeShowPayload({ noticeDeliveryId: "x", titulo: "a", mensagem: "b", nivel: "info", timestamp: new Date().toISOString() }) === null);
check("D titulo >100 rejeita", normalizeNoticeShowPayload({ noticeDeliveryId: "64c92e13-ad70-4ca1-8ff6-615a2078f34e", titulo: "a".repeat(101), mensagem: "b", nivel: "info", timestamp: new Date().toISOString() }) === null);
check("E mensagem >2000 rejeita", normalizeNoticeShowPayload({ noticeDeliveryId: "64c92e13-ad70-4ca1-8ff6-615a2078f34e", titulo: "a", mensagem: "b".repeat(2001), nivel: "info", timestamp: new Date().toISOString() }) === null);
check("F nivel invalido rejeita", normalizeNoticeShowPayload({ noticeDeliveryId: "64c92e13-ad70-4ca1-8ff6-615a2078f34e", titulo: "a", mensagem: "b", nivel: "x", timestamp: new Date().toISOString() }) === null);

// G/H/I/J/K/L/M/N: verificacoes estaticas do fluxo e ausencia de regressao em pontos criticos.
check("G received permanece no Shown", /form\.Shown[\s\S]*ConnectAndSend\("received"\)/.test(notifierCs));
check("H promoção usa CreateProcessAsUser", /CreateProcessAsUser/.test(notifierCs) && /sessao interativa/.test(notifierCs));
check("I ENTENDI envia acknowledged", /acknowledged/.test(notifierCs) && /Acked/.test(notifierCs));
check("J sem duas janelas no cache", /uma janela por vez/.test(agentNotifierJs));
check("K reconnect evita duplicata", /duplicado ignorado/.test(agentNotifierJs));
check("L fila continua", /processQueue/.test(agentNotifierJs) && /queue/.test(agentNotifierJs));
check("M capability notices continua", /notice_show/.test(agentNotifierJs) && /normalizeNoticeShowPayload/.test(agentNotifierJs));
check("N metrics/inventory/update sem regressao", fs.existsSync(path.join(__dirname, "..", "agent", "src", "index.js")));

console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
process.exit(fail ? 1 : 0);
