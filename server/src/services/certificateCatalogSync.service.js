const prisma = require("../prisma");
const certificatesService = require("./certificados.service");
const { logEvent } = require("../logger");

const HISTORY_LIMIT = 100;
const TRIGGERS = ["AUTOMATICA", "MANUAL"];

function makeError(code, message) { return Object.assign(new Error(message), { code }); }

function safeMessage(error) {
  if (!error) return null;
  if (["CERTIFICATE_ROOT_NOT_CONFIGURED", "CERTIFICATE_ROOT_UNAVAILABLE", "CERTIFICATE_ROOT_INVALID"].includes(error.code)) return "Raiz de certificados indisponível ou inválida.";
  if (error.code === "CERTIFICATE_SCAN_IN_PROGRESS") return "Já existe uma sincronização em andamento.";
  return "Não foi possível sincronizar o catálogo de certificados.";
}

function summary(status, trigger, startedAt, finishedAt, counts = {}, message = null) {
  return {
    origemCategoria: "CLIENTE",
    gatilho: trigger,
    status,
    iniciadaEm: startedAt,
    finalizadaEm: finishedAt,
    encontrados: counts.encontrados || 0,
    criados: counts.criados || 0,
    atualizados: counts.atualizados || 0,
    inativados: counts.inativados || 0,
    ignorados: counts.ignorados || 0,
    erros: counts.erros || 0,
    mensagemSegura: message,
    executadoPor: trigger === "MANUAL" ? counts.executadoPor || null : null
  };
}

function createCertificateCatalogSyncService({ db = prisma, sync = certificatesService.syncCatalog, log = logEvent, clock = () => new Date() } = {}) {
  let running = null;

  async function createHistory(data) {
    return db.sincronizacaoCatalogoCertificado.create({ data });
  }

  async function retainHistory() {
    const old = await db.sincronizacaoCatalogoCertificado.findMany({ orderBy: [{ iniciadaEm: "desc" }, { id: "desc" }], skip: HISTORY_LIMIT, select: { id: true } });
    if (old.length > 0) await db.sincronizacaoCatalogoCertificado.deleteMany({ where: { id: { in: old.map((item) => item.id) } } });
  }

  async function run(trigger = "MANUAL", executedBy = null) {
    if (!TRIGGERS.includes(trigger)) throw makeError("INVALID_TRIGGER", "Gatilho inválido.");
    if (running) throw makeError("CERTIFICATE_SYNC_IN_PROGRESS", "Já existe uma sincronização em andamento.");
    const operation = (async () => {
      const started = clock();
      const history = await createHistory({ origemCategoria: "CLIENTE", gatilho: trigger, status: "EM_ANDAMENTO", iniciadaEm: started, executadoPor: trigger === "MANUAL" ? String(executedBy || "ADMIN") : null });
      try {
        const counts = await sync({ db });
        const status = counts.erros > 0 ? "PARCIAL" : "SUCESSO";
        const finished = clock();
        const result = summary(status, trigger, started, finished, { ...counts, executadoPor: executedBy });
        await db.sincronizacaoCatalogoCertificado.update({ where: { id: history.id }, data: { status, finalizadaEm: finished, encontrados: result.encontrados, criados: result.criados, atualizados: result.atualizados, inativados: result.inativados, ignorados: result.ignorados, erros: result.erros, mensagemSegura: null } });
        await retainHistory();
        log(`[Monitor TI] sincronizacao_catalogo gatilho=${trigger} status=${status} encontrados=${result.encontrados} criados=${result.criados} atualizados=${result.atualizados} inativados=${result.inativados} ignorados=${result.ignorados} erros=${result.erros}`);
        return result;
      } catch (error) {
        const finished = clock();
        const message = safeMessage(error);
        await db.sincronizacaoCatalogoCertificado.update({ where: { id: history.id }, data: { status: "ERRO", finalizadaEm: finished, mensagemSegura: message } }).catch(() => {});
        log(`[Monitor TI] sincronizacao_catalogo gatilho=${trigger} status=ERRO erros=1`);
        throw Object.assign(new Error(message), { code: error.code === "CERTIFICATE_SCAN_IN_PROGRESS" ? error.code : "CERTIFICATE_SYNC_FAILED" });
      }
    })();
    running = operation;
    try { return await operation; } finally { if (running === operation) running = null; }
  }

  async function runAutomatic() {
    if (running) {
      const now = clock();
      await createHistory({ origemCategoria: "CLIENTE", gatilho: "AUTOMATICA", status: "IGNORADA_EM_ANDAMENTO", iniciadaEm: now, finalizadaEm: now, mensagemSegura: "Sincronização ignorada porque outra execução está em andamento." });
      log("[Monitor TI] sincronizacao_catalogo gatilho=AUTOMATICA status=IGNORADA_EM_ANDAMENTO");
      return summary("IGNORADA_EM_ANDAMENTO", "AUTOMATICA", now, now, {}, "Sincronização ignorada porque outra execução está em andamento.");
    }
    return run("AUTOMATICA");
  }

  async function runManual(executedBy) { return run("MANUAL", executedBy); }

  async function listHistory(limit = 20) {
    const parsed = Number.parseInt(String(limit || "20"), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_LIMIT) throw makeError("INVALID_LIMIT", "Limite inválido.");
    const rows = await db.sincronizacaoCatalogoCertificado.findMany({ where: { origemCategoria: "CLIENTE" }, orderBy: [{ iniciadaEm: "desc" }, { id: "desc" }], take: parsed });
    return rows.map(publicHistory);
  }

  async function current() {
    const rows = await db.sincronizacaoCatalogoCertificado.findMany({ where: { origemCategoria: "CLIENTE" }, orderBy: [{ iniciadaEm: "desc" }, { id: "desc" }], take: 1 });
    return rows[0] ? publicHistory(rows[0]) : null;
  }

  return { run, runAutomatic, runManual, listHistory, current, isRunning: () => Boolean(running), HISTORY_LIMIT };
}

function publicHistory(row) {
  return { id: row.id, origemCategoria: row.origemCategoria, gatilho: row.gatilho, status: row.status, iniciadaEm: row.iniciadaEm, finalizadaEm: row.finalizadaEm, encontrados: row.encontrados, criados: row.criados, atualizados: row.atualizados, inativados: row.inativados, ignorados: row.ignorados, erros: row.erros, mensagemSegura: row.mensagemSegura, executadoPor: row.executadoPor };
}

const defaultService = createCertificateCatalogSyncService();

module.exports = { HISTORY_LIMIT, createCertificateCatalogSyncService, publicHistory, ...defaultService };
