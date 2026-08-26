const crypto = require("crypto");
const prisma = require("../prisma");

// ============================================================================
// Avisos / Notificações remotas (Fase 11)
// - Servidor é dono dos agendamentos (PostgreSQL).
// - Timezone explicito America/Sao_Paulo para agendamentos.
// - Sem geracao antecipada de ocorrencias: so a regra + proximaExecucao.
// - Concorrencia: for_update no agendamento impede dupla ocorrencia.
// - Sem duplicacao apos restart: estado persiste no banco.
// ============================================================================

const NIVEIS = ["info", "aviso", "urgente"];
const ALVOS = ["todos", "online", "selecionados"];
const TIPOS_AGENDAMENTO = ["once", "daily", "weekly"];
const ESTADOS = ["PENDENTE", "ENVIADO", "EXIBIDO", "CONFIRMADO", "EXPIRADO", "FALHOU"];

const TZ = "America/Sao_Paulo";
const TICK_MS = 30000;
const EXPIRACAO_PADRAO_HORAS = 24;

let timerAgendador = null;

// ---------------------------------------------------------------------------
// Helpers de timezone (America/Sao_Paulo)
// ---------------------------------------------------------------------------

function spParts(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== "literal") p[part.type] = part.value;
  }
  return p;
}

// Converte uma data/hora "de parede" interpretada como America/Sao_Paulo
// para um instante UTC (Date).
function saoPauloParaUtc(year, month, day, hour, minute) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const p = spParts(new Date(utcGuess));
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

// Avanca N dias mantendo o mesmo horario de parede em Sao Paulo.
function proximaEmSaoPaulo(utcDate, dias) {
  const p = spParts(utcDate);
  return saoPauloParaUtc(
    Number(p.year),
    Number(p.month),
    Number(p.day) + dias,
    Number(p.hour),
    Number(p.minute)
  );
}

// ---------------------------------------------------------------------------
// Validacao / sanitizacao de conteudo (texto puro, sem URLs/HTML/JS)
// ---------------------------------------------------------------------------

const RE_BLOQUEADO = /(https?:\/\/|www\.|ftp:\/\/|file:\/\/|<\s*script|javascript:|<\s*a\s+href|cmd\.exe|powershell)/i;

function validarConteudo(titulo, mensagem) {
  if (typeof titulo !== "string" || titulo.trim().length === 0)
    throw new Error("Titulo obrigatorio.");
  if (titulo.length > 100)
    throw new Error("Titulo excede 100 caracteres.");
  if (typeof mensagem !== "string" || mensagem.trim().length === 0)
    throw new Error("Mensagem obrigatoria.");
  if (mensagem.length > 2000)
    throw new Error("Mensagem excede 2000 caracteres.");
  if (RE_BLOQUEADO.test(titulo + " " + mensagem))
    throw new Error("Conteudo contem URLs, HTML ou scripts nao permitidos.");
  return { titulo: titulo.trim(), mensagem: mensagem.trim() };
}

function normalizarNivel(nivel) {
  return NIVEIS.includes(nivel) ? nivel : "info";
}

function validarAlvo(tipo, ids) {
  if (!ALVOS.includes(tipo)) throw new Error("alvoTipo invalido.");
  if (tipo === "selecionados") {
    if (!Array.isArray(ids) || ids.length === 0)
      throw new Error("selecionados requer ao menos um id.");
    if (!ids.every((x) => Number.isInteger(x)))
      throw new Error("ids de computador invalidos.");
  }
}

// ---------------------------------------------------------------------------
// Resolucao de alvos -> lista de computadorId
// ---------------------------------------------------------------------------

async function resolverAlvos(tipo, alvoIdsJson, tx) {
  if (tipo === "todos") {
    const all = await tx.computador.findMany({ select: { id: true } });
    return all.map((c) => c.id);
  }
  if (tipo === "online") {
    const on = await tx.computador.findMany({
      where: { status: "online" },
      select: { id: true }
    });
    return on.map((c) => c.id);
  }
  if (tipo === "selecionados") {
    const ids = JSON.parse(alvoIdsJson || "[]");
    return ids.filter((x) => Number.isInteger(x));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Criacao de ocorrencia + entregas (usado por envio imediato e agendamento)
// ---------------------------------------------------------------------------

async function criarOcorrenciaEEntregas(tx, { aviso, alvoTipo, alvoIds, agendamentoId, agendadoPara }) {
  const ocorrencia = await tx.ocorrenciaAviso.create({
    data: {
      avisoId: aviso.id,
      agendamentoId: agendamentoId || null,
      agendadoPara,
      processado: true,
      alvoTipo,
      alvoIds: alvoTipo === "selecionados" ? JSON.stringify(alvoIds) : null
    }
  });

  const alvos = await resolverAlvos(
    alvoTipo,
    alvoTipo === "selecionados" ? JSON.stringify(alvoIds) : null,
    tx
  );

  const expiraEm = new Date(agendadoPara.getTime() + EXPIRACAO_PADRAO_HORAS * 3600 * 1000);

  for (const cid of alvos) {
    await tx.entregaAviso.create({
      data: {
        ocorrenciaId: ocorrencia.id,
        avisoId: aviso.id,
        computadorId: cid,
        noticeDeliveryId: crypto.randomUUID(),
        titulo: aviso.titulo,
        mensagem: aviso.mensagem,
        nivel: aviso.nivel,
        estado: "PENDENTE",
        expiraEm
      }
    });
  }

  return { ocorrencia, totalAlvos: alvos.length };
}

// ---------------------------------------------------------------------------
// Envio imediato ("Enviar agora")
// ---------------------------------------------------------------------------

async function criarAvisoImediato({ titulo, mensagem, nivel, alvoTipo, alvoIds }) {
  const v = validarConteudo(titulo, mensagem);
  titulo = v.titulo;
  mensagem = v.mensagem;
  nivel = normalizarNivel(nivel);
  const r = await prisma.$transaction(async (tx) => {
    const aviso = await tx.aviso.create({
      data: { titulo, mensagem, nivel, ativo: true }
    });
    const { ocorrencia, totalAlvos } = await criarOcorrenciaEEntregas(tx, {
      aviso,
      alvoTipo,
      alvoIds,
      agendamentoId: null,
      agendadoPara: new Date()
    });
    return { aviso, ocorrencia, totalAlvos };
  });
  await expedirPendentes();
  return r;
}

// Reenvio de um aviso ja existente
async function enviarAvisoExistente(id, { alvoTipo, alvoIds }) {
  validarAlvo(alvoTipo, alvoIds);
  const aviso = await prisma.aviso.findUnique({ where: { id } });
  if (!aviso) throw new Error("Aviso nao encontrado.");
  const r = await prisma.$transaction(async (tx) => {
    const { ocorrencia, totalAlvos } = await criarOcorrenciaEEntregas(tx, {
      aviso,
      alvoTipo,
      alvoIds,
      agendamentoId: null,
      agendadoPara: new Date()
    });
    return { aviso, ocorrencia, totalAlvos };
  });
  await expedirPendentes();
  return r;
}

// ---------------------------------------------------------------------------
// Agendamento (unico / diario / semanal)
// ---------------------------------------------------------------------------

function parseDataHora(data, hora) {
  const [Y, M, D] = String(data).split("-").map(Number);
  const [h, mi] = String(hora).split(":").map(Number);
  if (![Y, M, D, h, mi].every(Number.isFinite))
    throw new Error("data/hora invalidos.");
  return { Y, M, D, h, mi };
}

async function criarAgendamento({
  titulo,
  mensagem,
  nivel,
  alvoTipo,
  alvoIds,
  agendamento
}) {
  if (!agendamento) throw new Error("agendamento obrigatorio.");
  const tipo = agendamento.tipo;
  if (!TIPOS_AGENDAMENTO.includes(tipo))
    throw new Error("tipo de agendamento invalido.");
  if (!agendamento.data || !agendamento.hora)
    throw new Error("data/hora obrigatorios.");
  const { Y, M, D, h, mi } = parseDataHora(agendamento.data, agendamento.hora);
  const proxima = saoPauloParaUtc(Y, M, D, h, mi);

  let diaSemana = null;
  if (tipo === "weekly") {
    diaSemana =
      Number.isFinite(agendamento.diaSemana) && agendamento.diaSemana >= 0 && agendamento.diaSemana <= 6
        ? Number(agendamento.diaSemana)
        : proxima.getUTCDay();
  }

  const expiraEmHoras =
    Number(agendamento.expiraEmHoras) > 0 ? Number(agendamento.expiraEmHoras) : EXPIRACAO_PADRAO_HORAS;

  const r = await prisma.$transaction(async (tx) => {
    const aviso = await tx.aviso.create({
      data: { titulo, mensagem, nivel, ativo: true }
    });
    const ag = await tx.agendamentoAviso.create({
      data: {
        avisoId: aviso.id,
        tipo,
        diaSemana,
        agendadoPara: proxima,
        expiraEmHoras,
        alvoTipo,
        alvoIds: alvoTipo === "selecionados" ? JSON.stringify(alvoIds) : null,
        ativo: true,
        proximaExecucao: proxima
      }
    });
    return { aviso, agendamento: ag };
  });
  await expedirPendentes();
  return r;
}

// ---------------------------------------------------------------------------
// Atualizacao / exclusao de agendamentos
// ---------------------------------------------------------------------------

async function atualizarAgendamento(id, body) {
  const existente = await prisma.agendamentoAviso.findUnique({ where: { id } });
  if (!existente) throw new Error("Agendamento nao encontrado.");

  const data = {};
  if (typeof body.ativo === "boolean") data.ativo = body.ativo;

  if (body.alvoTipo) {
    validarAlvo(body.alvoTipo, body.alvoIds);
    data.alvoTipo = body.alvoTipo;
    data.alvoIds =
      body.alvoTipo === "selecionados" ? JSON.stringify(body.alvoIds) : null;
  }

  if (body.tipo && TIPOS_AGENDAMENTO.includes(body.tipo)) {
    data.tipo = body.tipo;
    if (body.tipo === "weekly") {
      data.diaSemana =
        Number.isFinite(body.diaSemana) && body.diaSemana >= 0 && body.diaSemana <= 6
          ? Number(body.diaSemana)
          : existente.diaSemana;
    } else {
      data.diaSemana = null;
    }
  }

  if (body.data && body.hora) {
    const { Y, M, D, h, mi } = parseDataHora(body.data, body.hora);
    const proxima = saoPauloParaUtc(Y, M, D, h, mi);
    data.agendadoPara = proxima;
    data.proximaExecucao = proxima;
  }

  if (Number(body.expiraEmHoras) > 0) data.expiraEmHoras = Number(body.expiraEmHoras);

  return prisma.agendamentoAviso.update({ where: { id }, data });
}

async function excluirAgendamento(id) {
  await prisma.$transaction(async (tx) => {
    await tx.agendamentoAviso.update({ where: { id }, data: { ativo: false } });
    const occ = await tx.ocorrenciaAviso.findMany({
      where: { agendamentoId: id },
      select: { id: true }
    });
    const ids = occ.map((o) => o.id);
    if (ids.length) {
      // Remove apenas entregas ainda nao enviadas (evita sumir aviso ja exibido)
      await tx.entregaAviso.deleteMany({
        where: { ocorrenciaId: { in: ids }, estado: "PENDENTE" }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Scheduler (tick unico por agendamento vencido; for_update evita dupla)
// ---------------------------------------------------------------------------

function calcularProxima(ag) {
  if (ag.tipo === "once") return null;
  const dias = ag.tipo === "weekly" ? 7 : 1;
  return proximaEmSaoPaulo(ag.proximaExecucao, dias);
}

async function processarUmAgendamento(agId, agora) {
  await prisma.$transaction(async (tx) => {
    const ag = await tx.agendamentoAviso.findFirst({
      where: { id: agId, ativo: true }
    });
    if (!ag || !ag.proximaExecucao || ag.proximaExecucao > agora) return;

    const novaProx = ag.tipo === "once" ? null : calcularProxima(ag);

    // Claim atomico: so tem efeito se ainda estiver vencido (outro tick que
    // ja processou tera avancado proximaExecucao ou desativado). Garante que
    // apenas UMA transacao cria a ocorrencia, mesmo com ticks concorrentes
    // ou restart do servidor (estado persiste no banco).
    const claim = await tx.agendamentoAviso.updateMany({
      where: { id: ag.id, ativo: true, proximaExecucao: { lte: agora } },
      data:
        ag.tipo === "once"
          ? { ativo: false, proximaExecucao: null }
          : { proximaExecucao: novaProx }
    });
    if (claim.count !== 1) return; // outro tick/processo ja processou

    const aviso = await tx.aviso.findUnique({ where: { id: ag.avisoId } });
    if (!aviso) return; // aviso sumiu; agendamento ja foi desativado via claim

    await criarOcorrenciaEEntregas(tx, {
      aviso,
      alvoTipo: ag.alvoTipo,
      alvoIds: ag.alvoIds ? JSON.parse(ag.alvoIds) : [],
      agendamentoId: ag.id,
      agendadoPara: ag.proximaExecucao
    });
  });
}

async function processarAgendamentosVencidos() {
  const agora = new Date();
  const vencidos = await prisma.agendamentoAviso.findMany({
    where: { ativo: true, proximaExecucao: { lte: agora } }
  });
  for (const ag of vencidos) {
    try {
      await processarUmAgendamento(ag.id, agora);
    } catch (e) {
      console.error(`[avisos] erro ao processar agendamento ${ag.id}:`, e.message);
    }
  }
  await expedirPendentes();
  await expirarEntregas();
}

// ---------------------------------------------------------------------------
// Expedicao (envio via WebSocket para os agents online)
// ---------------------------------------------------------------------------

async function enviarParaAgente(deviceId, entrega) {
  // require dinamico evita ciclo de dependencia com agentServer
  const agentServer = require("../ws/agentServer");
  return agentServer.sendToAgent(deviceId, {
    type: "notice_show",
    noticeDeliveryId: entrega.noticeDeliveryId,
    titulo: entrega.titulo,
    mensagem: entrega.mensagem,
    nivel: entrega.nivel,
    timestamp: entrega.criadoEm.toISOString()
  });
}

async function expedirPendentes() {
  const agora = new Date();
  const pendentes = await prisma.entregaAviso.findMany({
    where: { estado: "PENDENTE", expiraEm: { gt: agora } },
    include: { computador: true }
  });

  for (const e of pendentes) {
    let ok = false;
    try {
      ok = await enviarParaAgente(e.computador.deviceId, e);
    } catch (err) {
      console.error("[avisos] erro ao enviar notice_show:", err.message);
    }
    if (ok) {
      // Guarda concorrencia: so marca ENVIADO se ainda PENDENTE
      const r = await prisma.entregaAviso.updateMany({
        where: { id: e.id, estado: "PENDENTE" },
        data: { estado: "ENVIADO", enviadoEm: new Date() }
      });
      if (r.count === 0) {
        // Outro tick ja enviou; ignora
      }
    }
  }
}

// Usado no register do agente: envia pendentes desse deviceId (entrega pos-reconexao)
async function obterPendentesDoDispositivo(deviceId) {
  const agora = new Date();
  const pendentes = await prisma.entregaAviso.findMany({
    where: {
      estado: "PENDENTE",
      expiraEm: { gt: agora },
      computador: { deviceId }
    },
    include: { computador: true }
  });

  for (const e of pendentes) {
    let ok = false;
    try {
      ok = await enviarParaAgente(deviceId, e);
    } catch (err) {
      console.error("[avisos] erro ao enviar pendente:", err.message);
    }
    if (ok) {
      await prisma.entregaAviso.updateMany({
        where: { id: e.id, estado: "PENDENTE" },
        data: { estado: "ENVIADO", enviadoEm: new Date() }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Expiracao
// ---------------------------------------------------------------------------

async function expirarEntregas() {
  const agora = new Date();
  await prisma.entregaAviso.updateMany({
    where: {
      estado: { in: ["PENDENTE", "ENVIADO", "EXIBIDO"] },
      expiraEm: { lt: agora }
    },
    data: { estado: "EXPIRADO" }
  });
}

// ---------------------------------------------------------------------------
// Confirmacoes vindas do agente
// ---------------------------------------------------------------------------

async function marcarExibido(noticeDeliveryId, deviceId) {
  await prisma.entregaAviso.updateMany({
    where: {
      noticeDeliveryId,
      estado: { in: ["PENDENTE", "ENVIADO"] },
      computador: { deviceId }
    },
    data: { estado: "EXIBIDO", exibidoEm: new Date() }
  });
}

async function marcarConfirmado(noticeDeliveryId, deviceId) {
  await prisma.entregaAviso.updateMany({
    where: {
      noticeDeliveryId,
      estado: { in: ["PENDENTE", "ENVIADO", "EXIBIDO"] },
      computador: { deviceId }
    },
    data: { estado: "CONFIRMADO", confirmadoEm: new Date() }
  });
}

// ---------------------------------------------------------------------------
// Leitura (listagens / historico)
// ---------------------------------------------------------------------------

async function listarAvisos() {
  return prisma.aviso.findMany({
    orderBy: { criadoEm: "desc" },
    include: {
      agendamentos: {
        orderBy: { criadoEm: "desc" },
        include: { aviso: { select: { titulo: true, nivel: true } } }
      }
    }
  });
}

async function listarAgendamentos() {
  return prisma.agendamentoAviso.findMany({
    orderBy: { criadoEm: "desc" },
    include: { aviso: { select: { titulo: true, nivel: true, mensagem: true } } }
  });
}

async function obterEntregas(query = {}) {
  const where = {};
  if (query.computadorId) where.computadorId = Number(query.computadorId);
  if (query.estado) where.estado = String(query.estado).toUpperCase();
  if (query.from || query.to) {
    where.criadoEm = {};
    if (query.from) where.criadoEm.gte = new Date(query.from);
    if (query.to) where.criadoEm.lte = new Date(query.to);
  }
  return prisma.entregaAviso.findMany({
    where,
    orderBy: { criadoEm: "desc" },
    take: Number(query.limit) || 200,
    include: {
      computador: { select: { id: true, hostname: true, usuario: true } },
      aviso: { select: { titulo: true, nivel: true } }
    }
  });
}

// ---------------------------------------------------------------------------
// Agendador (loop no servidor)
// ---------------------------------------------------------------------------

async function tick() {
  try {
    await processarAgendamentosVencidos();
  } catch (e) {
    console.error("[avisos] erro no tick do agendador:", e.message);
  }
}

function iniciarAgendador() {
  if (timerAgendador) clearInterval(timerAgendador);
  timerAgendador = setInterval(tick, TICK_MS);
  if (timerAgendador.unref) timerAgendador.unref();
  // roda uma vez ja na inicializacao
  tick();
}

// ---------------------------------------------------------------------------
// Entrada unica (controller)
// ---------------------------------------------------------------------------

async function criarAviso(body) {
  const { titulo, mensagem } = validarConteudo(body.titulo, body.mensagem);
  const nivel = normalizarNivel(body.nivel);
  const alvoTipo = body.alvoTipo;
  const alvoIds = body.alvoIds || null;
  validarAlvo(alvoTipo, alvoIds);

  if (body.envio === "agendar") {
    return criarAgendamento({
      titulo,
      mensagem,
      nivel,
      alvoTipo,
      alvoIds,
      agendamento: body.agendamento
    });
  }
  return criarAvisoImediato({ titulo, mensagem, nivel, alvoTipo, alvoIds });
}

module.exports = {
  criarAviso,
  criarAvisoImediato,
  enviarAvisoExistente,
  criarAgendamento,
  atualizarAgendamento,
  excluirAgendamento,
  listarAvisos,
  listarAgendamentos,
  obterEntregas,
  marcarExibido,
  marcarConfirmado,
  obterPendentesDoDispositivo,
  expedirPendentes,
  expirarEntregas,
  processarAgendamentosVencidos,
  iniciarAgendador,
  // expostos p/ testes
  saoPauloParaUtc,
  proximaEmSaoPaulo
};
