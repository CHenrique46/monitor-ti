const { sendCurrentCapabilities } = require("../agent/src/capabilities");
const agentServer = require("../server/src/ws/agentServer");

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

class FakeWs {
  constructor(name) {
    this.name = name;
    this.readyState = 1;
    this.sent = [];
    this.closed = false;
  }

  send(payload) {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(JSON.parse(payload));
  }
}

function makeNotifier(state) {
  return {
    isNotifierReady() {
      if (state.throwReady) throw new Error("ready failed");
      return !!state.ready;
    }
  };
}

async function openFlow(ws, activeRef, notifier, logs, deviceId) {
  logs.push("WebSocket aberto");
  if (activeRef.current !== ws) {
    activeRef.current = ws;
  }
  ws.sent.push({ type: "register", data: { deviceId } });
  logs.push("register enviado");
  const ok = await sendCurrentCapabilities(ws, deviceId, notifier, (m) => logs.push(m));
  return ok;
}

async function announceFromReady(ws, activeRef, notifier, logs, deviceId) {
  if (activeRef.current !== ws) {
    logs.push("socket stale ignorado");
    return false;
  }
  return sendCurrentCapabilities(ws, deviceId, notifier, (m) => logs.push(m));
}

async function main() {
  const deviceId = "henrique-device";

  // A) Notifier válido antes do WS open -> register -> notices.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const ws = new FakeWs("A");
    await openFlow(ws, activeRef, notifier, logs, deviceId);
    check("A register enviado", ws.sent[0] && ws.sent[0].type === "register");
    check("A notices enviada", ws.sent[1] && ws.sent[1].type === "capabilities" && JSON.stringify(ws.sent[1].data.capabilities) === "[\"notices\"]");
    check("A log readiness", logs.some((l) => /Capabilities enviadas: notices/.test(l)));
  }

  // B) Notifier inválido no open -> capabilities [].
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: false });
    const ws = new FakeWs("B");
    await openFlow(ws, activeRef, notifier, logs, deviceId);
    check("B capabilities vazia", ws.sent[1] && ws.sent[1].type === "capabilities" && Array.isArray(ws.sent[1].data.capabilities) && ws.sent[1].data.capabilities.length === 0);
    check("B log nenhuma", logs.some((l) => /Capabilities enviadas: nenhuma/.test(l)));
  }

  // C) Notifier fica ready depois -> onNotifierReady envia notices.
  {
    const logs = [];
    const activeRef = { current: null };
    const state = { ready: false };
    const notifier = makeNotifier(state);
    const ws = new FakeWs("C");
    await openFlow(ws, activeRef, notifier, logs, deviceId);
    state.ready = true;
    await announceFromReady(ws, activeRef, notifier, logs, deviceId);
    const cap = ws.sent[2];
    check("C onNotifierReady notices", cap && cap.type === "capabilities" && JSON.stringify(cap.data.capabilities) === "[\"notices\"]");
  }

  // D) Server reset -> setCapabilities([]) remove notices e novo announce recria.
  {
    agentServer.setCapabilities("dev-d", ["notices"]);
    check("D1 server has notices", agentServer.hasCapability("dev-d", "notices") === true);
    agentServer.applyRegisterCapabilities("dev-d", []);
    check("D2 register vazio nao remove notices", agentServer.hasCapability("dev-d", "notices") === true);
    agentServer.clearCapabilities("dev-d");
    check("D3 disconnect real remove notices", agentServer.hasCapability("dev-d", "notices") === false && agentServer.getCapabilities("dev-d").length === 0);
  }

  // E) reconnect repetido -> notices continua correta.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const ws1 = new FakeWs("E1");
    const ws2 = new FakeWs("E2");
    await openFlow(ws1, activeRef, notifier, logs, deviceId);
    await openFlow(ws2, activeRef, notifier, logs, deviceId);
    check("E reconnect ws2 recebe notices", ws2.sent[1] && JSON.stringify(ws2.sent[1].data.capabilities) === "[\"notices\"]");
  }

  // F) socket A antigo fecha depois de B estar ativo -> A não interfere.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const wsA = new FakeWs("F-A");
    const wsB = new FakeWs("F-B");
    await openFlow(wsA, activeRef, notifier, logs, deviceId);
    await openFlow(wsB, activeRef, notifier, logs, deviceId);
    if (activeRef.current === wsB) logs.push("activeWs novo mantido");
    if (activeRef.current === wsA) activeRef.current = null;
    check("F activeWs mantido no novo socket", activeRef.current === wsB);
  }

  // G) socket A tenta capability depois de B assumir activeWs -> ignorado.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const wsA = new FakeWs("G-A");
    const wsB = new FakeWs("G-B");
    await openFlow(wsA, activeRef, notifier, logs, deviceId);
    activeRef.current = wsB;
    const ok = await announceFromReady(wsA, activeRef, notifier, logs, deviceId);
    check("G stale ignorado", ok === false && logs.some((l) => /socket stale ignorado/.test(l)));
  }

  // H) ws.send lança erro -> loga e continua.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const ws = new FakeWs("H");
    ws.throwOnSend = true;
    activeRef.current = ws;
    const ok = await sendCurrentCapabilities(ws, deviceId, notifier, (m) => logs.push(m));
    check("H send error logado", ok === false && logs.some((l) => /Erro ao enviar capabilities/.test(l)));
  }

  // I) isNotifierReady lança -> capability vazia/nenhuma, sem crash.
  {
    const logs = [];
    const ws = new FakeWs("I");
    const ok = await sendCurrentCapabilities(ws, deviceId, makeNotifier({ throwReady: true }), (m) => logs.push(m));
    check("I ready error logado", ok === false && logs.some((l) => /Erro ao enviar capabilities/.test(l)));
  }

  // J) setCapabilities(deviceId, []) remove notices anterior.
  {
    agentServer.setCapabilities("dev-j", ["notices"]);
    agentServer.applyRegisterCapabilities("dev-j", []);
    check("J register vazio nao remove", agentServer.hasCapability("dev-j", "notices") === true);
    agentServer.clearCapabilities("dev-j");
    check("J disconnect real remove", agentServer.hasCapability("dev-j", "notices") === false && agentServer.getCapabilities("dev-j").length === 0);
  }

  // K) regressão: register e capabilities continuam sendo os únicos eventos da capability path.
  {
    const logs = [];
    const activeRef = { current: null };
    const notifier = makeNotifier({ ready: true });
    const ws = new FakeWs("K");
    await openFlow(ws, activeRef, notifier, logs, deviceId);
    const types = ws.sent.map((m) => m.type);
    check("K register mantido", types[0] === "register");
    check("K capabilities mantida", types[1] === "capabilities");
  }

  console.log("\nRESULTADO: " + pass + " PASS, " + fail + " FAIL");
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("ERRO no teste:", err.stack || err.message);
  process.exit(1);
});
