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

export const TIMEZONE = "America/Sao_Paulo";

export const WEEKDAY_OPTIONS = [
  { value: 0, short: "Dom", long: "domingo" },
  { value: 1, short: "Seg", long: "segunda-feira" },
  { value: 2, short: "Ter", long: "terça-feira" },
  { value: 3, short: "Qua", long: "quarta-feira" },
  { value: 4, short: "Qui", long: "quinta-feira" },
  { value: 5, short: "Sex", long: "sexta-feira" },
  { value: 6, short: "Sáb", long: "sábado" }
];

const STATUS_ORDER = ["PENDENTE", "ENVIADO", "EXIBIDO", "CONFIRMADO", "EXPIRADO", "FALHOU"];

function normalizeText(value) {
  return String(value || "").trim();
}

export function normalizeSearchText(value) {
  return normalizeText(value).toLowerCase();
}

function computerSearchBlob(computer = {}) {
  return [computer.hostname, computer.usuario, computer.ip].filter(Boolean).join(" ").toLowerCase();
}

function historySearchBlob(item = {}) {
  const deliveryText = (item.deliveries || [])
    .map((delivery) => [delivery.computador?.hostname, delivery.computador?.usuario].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(" ");
  return [item.titulo, deliveryText].filter(Boolean).join(" ").toLowerCase();
}

function startOfZoneDay(date = new Date()) {
  const p = zoneParts(date);
  return saoPauloToUtc(Number(p.year), Number(p.month), Number(p.day), 0, 0);
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

function zoneParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts;
}

export function getZoneWeekday(date = new Date()) {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short"
  }).format(date);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[label] ?? 0;
}

export function saoPauloToUtc(year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const p = zoneParts(new Date(utcGuess));
  const spComoUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  const offset = spComoUtc - utcGuess;
  return new Date(utcGuess - offset);
}

export function getZoneDateInputValue(date = new Date()) {
  const p = zoneParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getZoneTimeInputValue(date = new Date()) {
  const p = zoneParts(date);
  return `${p.hour}:${p.minute}`;
}

export function formatZoneDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "short"
  }).format(d);
}

export function formatZoneTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

export function weekdayLabel(value, variant = "short") {
  const item = WEEKDAY_OPTIONS.find((opt) => opt.value === Number(value));
  return item ? item[variant] : "-";
}

export function formatRecurrenceLabel(schedule) {
  if (!schedule) return "-";
  const tipo = String(schedule.tipo || "").toLowerCase();
  const anchor = schedule.proximaExecucao || schedule.agendadoPara;
  const time = formatZoneTime(anchor);
  if (tipo === "once") {
    return `Uma vez - ${formatZoneDateTime(anchor)}`;
  }
  if (tipo === "daily") {
    return `Diariamente às ${time}`;
  }
  if (tipo === "weekly") {
    return `Toda ${weekdayLabel(schedule.diaSemana, "long")} às ${time}`;
  }
  return tipo || "-";
}

export function formatScheduleStatus(schedule) {
  if (!schedule) return "-";
  return schedule.ativo ? "Ativo" : "Inativo";
}

export function describeScheduleTarget(schedule, computers = []) {
  if (!schedule) return "-";
  if (schedule.alvoTipo === "todos") return "Todas as máquinas";
  if (schedule.alvoTipo === "online") return "Máquinas online";
  const ids = Array.isArray(schedule.alvoIds)
    ? schedule.alvoIds
    : (() => {
        try {
          return JSON.parse(schedule.alvoIds || "[]");
        } catch (e) {
          return [];
        }
      })();
  if (!ids.length) return "-";
  if (ids.length === computers.length && computers.length > 0) return "Todas as máquinas";
  return ids.length === 1 ? "1 máquina selecionada" : `${ids.length} máquinas selecionadas`;
}

export function getHistoryPeriodRange(period = 'all', now = new Date()) {
  const todayStart = startOfZoneDay(now);
  const periods = {
    today: todayStart,
    '7d': new Date(todayStart.getTime() - 6 * 24 * 3600 * 1000),
    '30d': new Date(todayStart.getTime() - 29 * 24 * 3600 * 1000)
  };
  const start = periods[period] || null;
  return {
    start,
    end: now
  };
}

export function filterAvisosHistory(history = [], filters = {}, now = new Date()) {
  const search = normalizeSearchText(filters.search);
  const status = String(filters.status || 'all').toUpperCase();
  const nivel = String(filters.nivel || 'all').toLowerCase();
  const period = String(filters.period || 'all').toLowerCase();
  const { start, end } = getHistoryPeriodRange(period, now);

  return (history || []).filter((item) => {
    if (search && !historySearchBlob(item).includes(search)) return false;
    if (status !== 'ALL' && String(item.primaryStatus || '').toUpperCase() !== status) return false;
    if (nivel !== 'all' && String(item.nivel || '').toLowerCase() !== nivel) return false;

    if (start || end) {
      const when = new Date(item.criadoEm || item.atualizadoEm || 0).getTime();
      if (start && when < start.getTime()) return false;
      if (end && when > end.getTime()) return false;
    }

    return true;
  });
}

export function summarizeHistoryDeliveries(history = []) {
  return (history || []).reduce(
    (acc, item) => {
      acc.registros += 1;
      acc.entregas += Number(item.quantidadeMaquinas || 0);
      return acc;
    },
    { registros: 0, entregas: 0 }
  );
}

export function formatNullableDateTime(value) {
  if (!value) return '—';
  const formatted = formatZoneDateTime(value);
  return formatted === '-' ? '—' : formatted;
}

export function isComputerReadyForNotice(computer = {}) {
  if (typeof computer.noticesReady === "boolean") return computer.noticesReady;
  if (typeof computer.notifierReady === "boolean") return computer.notifierReady;
  return null;
}

export function filterComputersForSelection(computers = [], filters = {}) {
  const search = normalizeSearchText(filters.search);
  const statusFilter = String(filters.statusFilter || "all").toLowerCase();
  const readinessFilter = String(filters.readinessFilter || "all").toLowerCase();

  return (computers || []).filter((computer) => {
    if (search && !computerSearchBlob(computer).includes(search)) return false;

    if (statusFilter === "online" && computer.status !== "online") return false;
    if (statusFilter === "offline" && computer.status !== "offline") return false;

    const ready = isComputerReadyForNotice(computer);
    if (readinessFilter === "ready" && ready !== true) return false;
    if (readinessFilter === "unready" && ready !== false) return false;

    return true;
  });
}

export function selectVisibleComputerIds(selectedIds = [], visibleComputers = []) {
  return Array.from(
    new Set([...(selectedIds || []).map((id) => Number(id)).filter(Number.isInteger), ...(visibleComputers || []).map((c) => Number(c.id)).filter(Number.isInteger)])
  );
}

export function buildSelectionSummary(computers = [], visibleComputers = [], selectedIds = []) {
  const total = (computers || []).length;
  const visible = (visibleComputers || []).length;
  const selected = Array.from(new Set((selectedIds || []).map((id) => Number(id)).filter(Number.isInteger))).length;
  const visibleSelected = (visibleComputers || []).filter((c) => selectedIds.includes(c.id)).length;
  return { total, visible, selected, visibleSelected };
}

export function buildAgendamentoDraft(form = {}, now = new Date()) {
  const tipo = String(form?.tipo || "once").toLowerCase();
  const hora = normalizeText(form?.hora);
  if (!hora || !/^\d{2}:\d{2}$/.test(hora)) {
    throw new Error("Hora obrigatória.");
  }

  const [h, mi] = hora.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) {
    throw new Error("Hora inválida.");
  }

  const current = zoneParts(now);

  if (tipo === "once") {
    if (!form?.data || !/^\d{4}-\d{2}-\d{2}$/.test(String(form.data))) {
      throw new Error("Data obrigatória.");
    }
    const [Y, M, D] = String(form.data).split("-").map(Number);
    if (![Y, M, D].every(Number.isInteger)) throw new Error("Data inválida.");
    const scheduledAt = saoPauloToUtc(Y, M, D, h, mi);
    if (scheduledAt.getTime() <= now.getTime()) {
      throw new Error("Escolha uma data/hora futura.");
    }
    return {
      tipo,
      data: form.data,
      hora,
      diaSemana: null,
      scheduledAt,
      summary: `Uma vez - ${formatZoneDateTime(scheduledAt)}`
    };
  }

  if (tipo === "daily") {
    const candidateToday = saoPauloToUtc(Number(current.year), Number(current.month), Number(current.day), h, mi);
    const scheduledAt = candidateToday.getTime() > now.getTime()
      ? candidateToday
      : saoPauloToUtc(Number(current.year), Number(current.month), Number(current.day) + 1, h, mi);
    return {
      tipo,
      data: `${current.year}-${current.month}-${current.day}`,
      hora,
      diaSemana: null,
      scheduledAt,
      summary: `Diariamente às ${hora}`
    };
  }

  if (tipo === "weekly") {
    const weekday = Number(form?.diaSemana);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new Error("Dia da semana obrigatório.");
    }
    const currentWeekday = getZoneWeekday(now);
    const delta = (weekday - currentWeekday + 7) % 7;
    let scheduledAt = saoPauloToUtc(Number(current.year), Number(current.month), Number(current.day) + delta, h, mi);
    if (scheduledAt.getTime() <= now.getTime()) {
      scheduledAt = saoPauloToUtc(Number(current.year), Number(current.month), Number(current.day) + delta + 7, h, mi);
    }
    return {
      tipo,
      data: getZoneDateInputValue(scheduledAt),
      hora,
      diaSemana: weekday,
      scheduledAt,
      summary: `Toda ${weekdayLabel(weekday, "long")} às ${hora}`
    };
  }

  throw new Error("Tipo de agendamento inválido.");
}

export function buildAgendamentoCreatePayload(form = {}, selectedIds = [], now = new Date()) {
  const draft = buildAgendamentoDraft(form, now);
  const alvoTipo = String(form?.alvoTipo || "todos").trim();
  const payload = {
    titulo: normalizeText(form?.titulo),
    mensagem: normalizeText(form?.mensagem),
    nivel: mapNivelToBackend(form?.nivel),
    alvoTipo,
    envio: "agendar",
    agendamento: {
      tipo: draft.tipo,
      data: draft.data,
      hora: draft.hora
    }
  };

  if (draft.diaSemana != null) payload.agendamento.diaSemana = draft.diaSemana;

  if (alvoTipo === "selecionados") {
    const ids = Array.from(new Set((selectedIds || []).map((id) => Number(id)).filter(Number.isInteger)));
    payload.alvoIds = ids;
  }

  return { payload, draft };
}

export function buildAgendamentoUpdateBody(form = {}, selectedIds = [], now = new Date()) {
  const { payload } = buildAgendamentoCreatePayload(form, selectedIds, now);
  return {
    titulo: payload.titulo,
    mensagem: payload.mensagem,
    nivel: payload.nivel,
    alvoTipo: payload.alvoTipo,
    ...(payload.alvoIds ? { alvoIds: payload.alvoIds } : {}),
    tipo: payload.agendamento.tipo,
    data: payload.agendamento.data,
    hora: payload.agendamento.hora,
    ...(payload.agendamento.diaSemana != null ? { diaSemana: payload.agendamento.diaSemana } : {})
  };
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

export function getScheduleFormFromRecord(record = {}) {
  const anchor = record.agendadoPara || record.proximaExecucao || null;
  const tipo = String(record.tipo || "once");
  const weekdayFromAnchor = anchor ? getZoneWeekday(anchor) : 0;
  return {
    titulo: record.aviso?.titulo || "",
    mensagem: record.aviso?.mensagem || "",
    nivel: record.aviso?.nivel || "info",
    alvoTipo: record.alvoTipo || "todos",
    alvoIds: Array.isArray(record.alvoIds)
      ? record.alvoIds
      : (() => {
          try {
            return JSON.parse(record.alvoIds || "[]");
          } catch (e) {
            return [];
          }
        })(),
    tipo,
    data: anchor ? getZoneDateInputValue(anchor) : "",
    hora: anchor ? getZoneTimeInputValue(anchor) : "",
    diaSemana: record.diaSemana != null ? Number(record.diaSemana) : weekdayFromAnchor
  };
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
  TIMEZONE,
  WEEKDAY_OPTIONS,
  mapNivelToBackend,
  mapNivelToLabel,
  mapEstadoToLabel,
  buildAvisoPayload,
  formatApiError,
  saoPauloToUtc,
  getZoneWeekday,
  getZoneDateInputValue,
  getZoneTimeInputValue,
  formatZoneDateTime,
  formatZoneTime,
  weekdayLabel,
  formatRecurrenceLabel,
  formatScheduleStatus,
  describeScheduleTarget,
  isComputerReadyForNotice,
  filterComputersForSelection,
  selectVisibleComputerIds,
  buildSelectionSummary,
  getHistoryPeriodRange,
  filterAvisosHistory,
  summarizeHistoryDeliveries,
  formatNullableDateTime,
  buildAgendamentoDraft,
  buildAgendamentoCreatePayload,
  buildAgendamentoUpdateBody,
  groupAvisosHistory,
  historyStatusSummary,
  inferDestinoLabel,
  countByStatus,
  statusPriority,
  getScheduleFormFromRecord
};
