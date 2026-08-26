const prisma = require("../prisma");

const PERIODOS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const BUCKETS = {
  "24h": 5 * 60 * 1000,
  "7d": 15 * 60 * 1000,
  "30d": 60 * 60 * 1000
};

function parsePeriodo(p) {
  if (p && PERIODOS[p]) return p;
  return "24h";
}

async function getMetricas(computadorId, periodoParam) {
  const periodo = parsePeriodo(periodoParam);
  const fromMs = Date.now() - PERIODOS[periodo];
  const from = new Date(fromMs);
  const bucket = BUCKETS[periodo];

  const rows = await prisma.metricaComputador.findMany({
    where: {
      computadorId: Number(computadorId),
      coletadoEm: { gte: from }
    },
    orderBy: { coletadoEm: "asc" }
  });

  if (rows.length === 0) return [];

  // Downsampling por media em buckets de tempo
  const buckets = new Map();
  for (const r of rows) {
    const t = r.coletadoEm.getTime();
    const b = Math.floor((t - fromMs) / bucket) * bucket + fromMs;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(r);
  }

  const pontos = [];
  for (const [b, rs] of [...buckets.entries()].sort((a, c) => a[0] - c[0])) {
    const avg = (sel) => {
      const vals = rs.map(sel).filter((v) => v != null && Number.isFinite(v));
      if (!vals.length) return null;
      return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
    };
    pontos.push({
      coletadoEm: new Date(b).toISOString(),
      cpuUso: avg((r) => r.cpuUso),
      ramUsoPct: avg((r) => r.ramUsoPct),
      discoUsoPct: avg((r) => r.discoUsoPct),
      ramUsada: rs[0].ramUsada,
      ramTotal: rs[0].ramTotal,
      discoLivre: rs[0].discoLivre,
      discoTotal: rs[0].discoTotal
    });
  }

  return pontos;
}

module.exports = { getMetricas, PERIODOS };
