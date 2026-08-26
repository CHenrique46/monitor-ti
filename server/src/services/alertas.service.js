const prisma = require("../prisma");
const { logEvent } = require("../logger");

const DISCO_CRITICO_GIB = 15;
const DISCO_ATENCAO_GIB = 30;
const RAM_ATENCAO = 80;
const RAM_CRITICO = 90;
const CPU_ALERTA = 90;
const CPU_CICLOS = 3;

const GiB = 1024 ** 3;

// Contador de CPUs altas consecutivas (em memoria; zera no restart do Server - aceitavel)
const cpuHigh = new Map();
// Cache do nivel desejado por recurso (otimizacao para evitar consultas a cada metrica)
const lastDesired = new Map();

function round1(v) {
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

// Determina o estado desejado de alerta por recurso.
// Retorna mapa: { RAM?: {...}, DISCO?: {...}, CPU?: {...} } (ausencia = sem alerta)
function desiredFor(state) {
  const out = {};

  // RAM
  if (
    Number.isFinite(state.ramTotal) &&
    state.ramTotal > 0 &&
    Number.isFinite(state.ramUsada)
  ) {
    const pct = (state.ramUsada / state.ramTotal) * 100;
    if (pct >= RAM_CRITICO) {
      out.RAM = {
        nivel: "critical",
        mensagem: `Uso elevado de memória (${Math.round(pct)}%)`,
        valor: round1(pct),
        limite: RAM_CRITICO
      };
    } else if (pct >= RAM_ATENCAO) {
      out.RAM = {
        nivel: "warn",
        mensagem: `Uso elevado de memória (${Math.round(pct)}%)`,
        valor: round1(pct),
        limite: RAM_ATENCAO
      };
    }
  }

  // DISCO (espaco livre em GiB)
  if (Number.isFinite(state.discoLivre)) {
    const freeGib = state.discoLivre / GiB;
    if (freeGib < DISCO_CRITICO_GIB) {
      out.DISCO = {
        nivel: "critical",
        mensagem: `Pouco espaço em disco (${freeGib.toFixed(1)} GB livres)`,
        valor: round1(freeGib),
        limite: DISCO_CRITICO_GIB
      };
    } else if (freeGib < DISCO_ATENCAO_GIB) {
      out.DISCO = {
        nivel: "warn",
        mensagem: `Pouco espaço em disco (${freeGib.toFixed(1)} GB livres)`,
        valor: round1(freeGib),
        limite: DISCO_ATENCAO_GIB
      };
    }
  }

  // CPU (consecutivo)
  const key = state.computadorId;
  let count = cpuHigh.get(key) || 0;
  if (Number.isFinite(state.cpuUso) && state.cpuUso >= CPU_ALERTA) {
    count += 1;
  } else {
    count = 0;
  }
  cpuHigh.set(key, count);
  if (count >= CPU_CICLOS) {
    out.CPU = {
      nivel: "critical",
      mensagem: `CPU elevada por tempo prolongado (${Math.round(state.cpuUso)}%)`,
      valor: round1(state.cpuUso),
      limite: CPU_ALERTA
    };
  }

  return out;
}

async function reconciliar(computadorId, tipo, desejado) {
  const cacheKey = computadorId + ":" + tipo;
  const nivelAtual = desejado ? desejado.nivel : null;
  if (lastDesired.get(cacheKey) === nivelAtual) return; // sem mudanca de nivel
  lastDesired.set(cacheKey, nivelAtual);

  try {
    const ativo = await prisma.alerta.findFirst({
      where: { computadorId, tipo, ativo: true },
      orderBy: { iniciadoEm: "desc" }
    });

    if (!desejado) {
      if (ativo) {
        await prisma.alerta.update({
          where: { id: ativo.id },
          data: { ativo: false, resolvidoEm: new Date() }
        });
        logEvent(`Alerta resolvido (${tipo}) - computador ${computadorId}`);
      }
      return;
    }

    if (ativo && ativo.nivel === desejado.nivel) {
      return; // ja existe ativo no mesmo nivel: nao duplicar
    }

    // Nivel mudou (ou nao havia): resolve anterior e cria novo
    if (ativo) {
      await prisma.alerta.update({
        where: { id: ativo.id },
        data: { ativo: false, resolvidoEm: new Date() }
      });
    }
    await prisma.alerta.create({
      data: {
        computadorId,
        tipo,
        nivel: desejado.nivel,
        mensagem: desejado.mensagem,
        valor: desejado.valor,
        limite: desejado.limite
      }
    });
    logEvent(
      `Alerta ${desejado.nivel} criado (${tipo}) - computador ${computadorId}: ${desejado.mensagem}`
    );
  } catch (e) {
    // Reverter cache para tentar novamente na proxima metrica
    lastDesired.delete(cacheKey);
    logEvent("Erro ao reconciliar alerta: " + e.message);
  }
}

async function avaliar(state) {
  if (!state.computadorId) return;
  // desiredFor atualiza o contador de CPU de forma sincrona antes de qualquer await
  const desejados = desiredFor(state);
  for (const tipo of ["RAM", "DISCO", "CPU"]) {
    await reconciliar(state.computadorId, tipo, desejados[tipo] || null);
  }
}

async function listAlertas({ ativos, computadorId } = {}) {
  const where = {};
  if (ativos === true) where.ativo = true;
  if (computadorId) where.computadorId = Number(computadorId);

  const items = await prisma.alerta.findMany({
    where,
    include: {
      computador: {
        select: { hostname: true, usuario: true, deviceId: true }
      }
    },
    orderBy: [{ ativo: "desc" }, { iniciadoEm: "desc" }]
  });

  return items;
}

module.exports = { avaliar, listAlertas };
