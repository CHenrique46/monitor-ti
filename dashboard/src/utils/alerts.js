import { gb } from "./formatters";

// Limiares de alerta (fase 5, sem histórico ainda)
const DISCO_CRITICO_GB = 15;
const DISCO_ATENCAO_GB = 30;
const RAM_ATENCAO = 80;
const RAM_CRITICO = 90;
const CPU_ALERTA = 90;

export function computeAlerts(c) {
  const alerts = [];

  // Máquina offline: mantém últimas métricas, mas não gera alerta ativo
  if (c.status !== "online") {
    return { alerts, hasAlert: false, critical: false };
  }

  const diskFree = gb(c.discoLivre);
  if (diskFree != null) {
    if (diskFree < DISCO_CRITICO_GB) {
      alerts.push({
        type: "disk",
        severity: "critical",
        msg: `Pouco espaço em disco (${diskFree.toFixed(1)} GB livres)`
      });
    } else if (diskFree < DISCO_ATENCAO_GB) {
      alerts.push({
        type: "disk",
        severity: "warn",
        msg: `Pouco espaço em disco (${diskFree.toFixed(1)} GB livres)`
      });
    }
  }

  if (c.ramTotal && c.ramUsada != null) {
    const pct = (c.ramUsada / c.ramTotal) * 100;
    if (pct >= RAM_CRITICO) {
      alerts.push({ type: "ram", severity: "critical", msg: "Uso elevado de memória" });
    } else if (pct >= RAM_ATENCAO) {
      alerts.push({ type: "ram", severity: "warn", msg: "Uso elevado de memória" });
    }
  }

  if (c.cpuUso != null && c.cpuUso >= CPU_ALERTA) {
    alerts.push({
      type: "cpu",
      severity: "critical",
      msg: `CPU elevada (${Math.round(c.cpuUso)}%)`
    });
  }

  const critical = alerts.some((a) => a.severity === "critical");
  return { alerts, hasAlert: alerts.length > 0, critical };
}

export function sortComputadores(list) {
  const score = (c) => {
    const { critical } = computeAlerts(c);
    if (critical) return 0; // alerta crítico primeiro
    if (c.status === "offline") return 1; // depois offline
    return 2; // por último: online sem alerta
  };

  return [...list].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sa !== sb) return sa - sb;
    return (a.hostname || "").localeCompare(b.hostname || "");
  });
}
