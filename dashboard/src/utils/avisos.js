export const NIVEL_OPTIONS = [
  { label: "Informativo", value: "info" },
  { label: "Atenção", value: "aviso" },
  { label: "Crítico", value: "urgente" }
];

export const STATUS_LABELS = {
  PENDENTE: "Pendente",
  ENVIADO: "Enviado",
  EXIBIDO: "Exibido",
  CONFIRMADO: "Confirmado",
  EXPIRADO: "Expirado",
  FALHOU: "Falhou"
};

const STATUS_ORDER = ["PENDENTE", "ENVIADO", "EXIBIDO", "CONFIRMADO", "EXPIRADO", "FALHOU"];

function normalizeText(value) {
  return String(value || "").trim();
}

export function mapNivelToBackend(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return "info";
  if (raw === "informativo" || raw === "info") return "info";
  if (raw === "atenção" || raw === "atencao" || raw === "aviso") return "aviso";
  if (raw === "crítico" || raw === "critico" || raw === "urgente") return "urgente";
  return "info";
}

export function mapNivelToLabel(value) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === "info") return "Informativo";
  if (raw === "aviso") return "Atenção";
  if (raw === "urgente") return "Crítico";
  return normalizeText(value) || "Informativo";
}

export function mapEstadoToLabel(value) {
  return STATUS_LABELS[String(value || "").toUpperCase()] || normalizeText(value) || "-";
}

function statusPriority(value) {
  const idx = STATUS_ORDER.indexOf(String(value || "").toUpperCase());
  return idx < 0 ? STATUS_ORDER.length : idx;
}

export function buildAvisoPayload(form, selectedIds = []) {
  const alvoTipo = String(form?.alvoTipo || "todos").trim();
  const payload = {
    titulo: normalizeText(form?.titulo),
    mensagem: normalizeText(form?.mensagem),
    nivel: mapNivelToBackend(form?.nivel),
    alvoTipo
  };

  if (alvoTipo === "selecionados") {
    const ids = Array.from(new Set((selectedIds || []).map((id) => Number(id)).filter(Number.isInteger)));
    payload.alvoIds = ids;
  }

  return payload;
}

export function formatApiError(err, fallback = "Falha ao enviar aviso") {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  if (err.erro) return err.erro;
  if (err.message) return err.message;
  if (err.statusText) return err.statusText;
  return fallback;
}

export function countByStatus(deliveries) {
  const counts = { PENDENTE: 0, ENVIADO: 0, EXIBIDO: 0, CONFIRMADO: 0, EXPIRADO: 0, FALHOU: 0 };
  for (const item of deliveries || []) {
    const key = String(item?.estado || "").toUpperCase();
    if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] += 1;
  }
  return counts;
}

export function inferDestinoLabel(deliveries, computers = []) {
  const ids = Array.from(new Set((deliveries || []).map((d) => d.computadorId).filter((id) => id != null)));
  if (!ids.length) return "-";

  const total = computers.length;
  const onlineIds = new Set(computers.filter((c) => c.status === "online").map((c) => c.id));
  const allIds = new Set(computers.map((c) => c.id));
  const allMatch = total > 0 && ids.length === total && ids.every((id) => allIds.has(id));
  const onlineMatch = onlineIds.size > 0 && ids.length === onlineIds.size && ids.every((id) => onlineIds.has(id));

  if (allMatch) return "Todas as máquinas";
  if (onlineMatch) return "Máquinas online";
  return ids.length === 1 ? "1 máquina selecionada" : `${ids.length} máquinas selecionadas`;
}

export function groupAvisosHistory(avisos = [], entregas = [], computers = []) {
  const avisosById = new Map((avisos || []).map((a) => [a.id, a]));
  const groups = new Map();

  for (const entrega of entregas || []) {
    if (!entrega || entrega.avisoId == null) continue;
    const groupKey = entrega.ocorrenciaId != null ? `ocorrencia:${entrega.ocorrenciaId}` : `aviso:${entrega.avisoId}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entrega);
  }

  return Array.from(groups.entries())
    .map(([groupKey, group]) => {
      const avisoId = group[0]?.avisoId;
      const aviso = avisosById.get(avisoId) || group[0]?.aviso || {};
      const deliveries = [...group].sort((a, b) => {
        const da = new Date(a.criadoEm || a.atualizadoEm || 0).getTime();
        const db = new Date(b.criadoEm || b.atualizadoEm || 0).getTime();
        return db - da;
      });
      const counts = countByStatus(deliveries);
      const total = deliveries.length;
      const firstAt = deliveries[deliveries.length - 1]?.criadoEm || aviso.criadoEm || null;
      const lastAt = deliveries[0]?.atualizadoEm || deliveries[0]?.criadoEm || aviso.criadoEm || null;

      return {
        id: groupKey,
        avisoId,
        ocorrenciaId: group[0]?.ocorrenciaId || null,
        titulo: aviso.titulo || deliveries[0]?.titulo || "(sem título)",
        nivel: aviso.nivel || deliveries[0]?.nivel || "info",
        criadoEm: aviso.criadoEm || firstAt,
        atualizadoEm: aviso.atualizadoEm || lastAt,
        destinoLabel: inferDestinoLabel(deliveries, computers),
        quantidadeMaquinas: total,
        counts,
        primaryStatus: STATUS_ORDER.find((s) => counts[s] > 0) || deliveries[0]?.estado || "PENDENTE",
        deliveries
      };
    })
    .sort((a, b) => new Date(b.criadoEm || 0).getTime() - new Date(a.criadoEm || 0).getTime());
}

export function historyStatusSummary(counts = {}) {
  const parts = STATUS_ORDER.filter((status) => counts[status] > 0).map(
    (status) => `${mapEstadoToLabel(status)} ${counts[status]}`
  );
  return parts.length ? parts.join(" · ") : "Sem entregas";
}

export { statusPriority };

export default {
  NIVEL_OPTIONS,
  STATUS_LABELS,
  mapNivelToBackend,
  mapNivelToLabel,
  mapEstadoToLabel,
  buildAvisoPayload,
  formatApiError,
  groupAvisosHistory,
  historyStatusSummary,
  inferDestinoLabel,
  countByStatus,
  statusPriority
};
