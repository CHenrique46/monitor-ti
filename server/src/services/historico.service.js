const prisma = require("../prisma");
const { logEvent } = require("../logger");

const INTERVAL_MS = Number(process.env.METRICS_HISTORY_INTERVAL_MS) || 5 * 60 * 1000;
const RETENCAO_DIAS = 30;

// Cache da ultima amostra salva por computador (evita 1 leitura de DB por mensagem)
const lastSampleAt = new Map();
// Dedupe de chamadas concorrentes por computador
const sampling = new Map();

function clampPct(v) {
  if (!Number.isFinite(v)) return null;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function computarPcts(state) {
  let ramUsoPct = null;
  let discoUsoPct = null;

  if (Number.isFinite(state.ramTotal) && state.ramTotal > 0 && Number.isFinite(state.ramUsada)) {
    ramUsoPct = clampPct((state.ramUsada / state.ramTotal) * 100);
  }
  if (
    Number.isFinite(state.discoTotal) &&
    state.discoTotal > 0 &&
    Number.isFinite(state.discoLivre)
  ) {
    discoUsoPct = clampPct(((state.discoTotal - state.discoLivre) / state.discoTotal) * 100);
  }

  return { ramUsoPct, discoUsoPct };
}

async function getLastSampleTime(id) {
  if (lastSampleAt.has(id)) return lastSampleAt.get(id);
  const rec = await prisma.metricaComputador.findFirst({
    where: { computadorId: id },
    orderBy: { coletadoEm: "desc" },
    select: { coletadoEm: true }
  });
  const t = rec ? rec.coletadoEm.getTime() : 0;
  lastSampleAt.set(id, t);
  return t;
}

async function maybeSaveSample(state) {
  const id = state.computadorId;
  if (!id) return;
  try {
    const now = Date.now();
    const last = await getLastSampleTime(id);
    if (now - last < INTERVAL_MS) return;
    if (sampling.has(id)) return;

    const p = (async () => {
      const last2 = await getLastSampleTime(id);
      if (Date.now() - last2 < INTERVAL_MS) return;
      // Lock otimista antes do insert assincrono para evitar duplicatas no intervalo
      lastSampleAt.set(id, Date.now());

      const { ramUsoPct, discoUsoPct } = computarPcts(state);
      const data = {
        computadorId: id,
        cpuUso: Number.isFinite(state.cpuUso) ? state.cpuUso : null,
        ramUsoPct,
        discoUsoPct,
        ramUsada: Number.isFinite(state.ramUsada) ? state.ramUsada : null,
        ramTotal: Number.isFinite(state.ramTotal) ? state.ramTotal : null,
        discoLivre: Number.isFinite(state.discoLivre) ? state.discoLivre : null,
        discoTotal: Number.isFinite(state.discoTotal) ? state.discoTotal : null
      };

      // Nunca gravar NaN/Infinity
      Object.keys(data).forEach((k) => {
        if (k === "computadorId") return;
        if (data[k] !== null && !Number.isFinite(data[k])) data[k] = null;
      });

      await prisma.metricaComputador.create({ data });
    })();

    sampling.set(id, p);
    await p;
  } catch (e) {
    // Falha de amostragem nao deve interromper o processamento de metricas
  } finally {
    sampling.delete(id);
  }
}

async function limparAntigos() {
  const corte = new Date(Date.now() - RETENCAO_DIAS * 24 * 60 * 60 * 1000);
  try {
    const r = await prisma.metricaComputador.deleteMany({
      where: { coletadoEm: { lt: corte } }
    });
    if (r.count) {
      logEvent(`Retencao: removidas ${r.count} amostras anteriores a ${RETENCAO_DIAS} dias.`);
    }
  } catch (e) {
    logEvent("Erro na retencao de historicos: " + e.message);
  }
}

let timerRetencao = null;
function iniciarRetencao() {
  limparAntigos();
  if (timerRetencao) clearInterval(timerRetencao);
  timerRetencao = setInterval(limparAntigos, 24 * 60 * 60 * 1000);
  if (timerRetencao.unref) timerRetencao.unref();
}

function pararRetencao() {
  if (timerRetencao) clearInterval(timerRetencao);
  timerRetencao = null;
}

module.exports = { maybeSaveSample, iniciarRetencao, pararRetencao, stop: pararRetencao, INTERVAL_MS, RETENCAO_DIAS };
