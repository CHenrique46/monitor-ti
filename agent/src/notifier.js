const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, execFile, execFileSync } = require("child_process");

// ===== MonitorTI Notifier integration (Agent side) =====
// - Recebe "notice_show" do servidor.
// - Fila local (uma janela por vez, sem sobreposição).
// - Cache de deduplicação em %ProgramData%\MonitorTI\notice-cache.json.
// - Cria um Named Pipe \\.\pipe\MonitorTI-Notice-<uuid> e lança o
//   MonitorTI-Notifier.exe na sessão interativa do usuário (via WTS APIs).
// - O Notifier reporta "received" (exibido) e "acknowledged" (Entendi) pelo pipe.
// - O Agent retransmite notice_received / notice_acknowledged ao servidor.

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PIPE_PREFIX = "MonitorTI-Notice-";
const RECEIVED_TIMEOUT_MS = 60000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_INTEGRITY_FILE = "notifier-integrity.json";

function isValidLevel(level) {
  return ["info", "aviso", "urgente"].includes(String(level || "").toLowerCase());
}

function normalizeNoticeShowPayload(msg) {
  const raw = msg && typeof msg === "object" ? (msg.data && typeof msg.data === "object" ? msg.data : msg) : null;
  if (!raw || typeof raw !== "object") return null;

  const noticeDeliveryId = String(raw.noticeDeliveryId || "").trim();
  const title = String(raw.title || raw.titulo || "").trim();
  const message = String(raw.message || raw.mensagem || "").trim();
  const level = String(raw.level || raw.nivel || "").trim().toLowerCase();
  const timestamp = String(raw.timestamp || raw.serverTime || raw.scheduledAt || "").trim();

  if (!UUID_RE.test(noticeDeliveryId)) return null;
  if (!title || title.length > 100) return null;
  if (!message || message.length > 2000) return null;
  if (!isValidLevel(level)) return null;
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return null;

  return {
    noticeDeliveryId,
    title,
    message,
    level,
    scheduledAt: String(raw.scheduledAt || raw.timestamp || timestamp).trim(),
    serverTime: String(raw.serverTime || raw.timestamp || timestamp).trim()
  };
}

function createNotifier(opts) {
  const { configDir, getAppDir, getDeviceId, getWs, logEvent, version, getServerHttpBase, onNotifierReady } = opts;

  const NOTICES_DIR = path.join(configDir, "notices");
  const CACHE_FILE = path.join(configDir, "notice-cache.json");
  const inProgress = new Map();
  const queue = [];
  const queueSet = new Set();
  const NOTIFIER_RETRY_INITIAL_MS = 15000;
  const NOTIFIER_RETRY_MAX_MS = 5 * 60 * 1000;

  let expectedReleaseMeta = null;
  let expectedReleaseMetaPromise = null;
  let ensureRunning = false;
  let retryTimer = null;
  let retryDelayMs = NOTIFIER_RETRY_INITIAL_MS;

  function sha256File(p) {
    const h = crypto.createHash("sha256");
    h.update(fs.readFileSync(p));
    return h.digest("hex");
  }

  function baseHttpUrl() {
    const httpBase = (getServerHttpBase && getServerHttpBase()) || "";
    return httpBase.replace(/^ws/i, "http").replace(/^wss/i, "https");
  }

  function expectedNotifierSha() {
    return expectedReleaseMeta && expectedReleaseMeta.notifierSha256
      ? String(expectedReleaseMeta.notifierSha256)
      : null;
  }

  function resetRetryBackoff() {
    retryDelayMs = NOTIFIER_RETRY_INITIAL_MS;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(reason) {
    if (retryTimer) return;
    const delay = retryDelayMs;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      ensureNotifierPresent();
    }, delay);
    if (typeof retryTimer.unref === "function") retryTimer.unref();
    retryDelayMs = Math.min(retryDelayMs * 2, NOTIFIER_RETRY_MAX_MS);
    logEvent("aviso: rechecando Notifier em " + Math.round(delay / 1000) + "s: " + reason);
  }

  async function loadExpectedReleaseMeta() {
    if (expectedReleaseMeta) return expectedReleaseMeta;
    if (expectedReleaseMetaPromise) return expectedReleaseMetaPromise;

    expectedReleaseMetaPromise = (async () => {
      const base = baseHttpUrl();
      if (!base) throw new Error("URL do servidor indisponivel");
      const res = await fetch(base + "/api/agent/releases/" + version);
      if (!res.ok) throw new Error("metadata HTTP " + res.status);
      const meta = await res.json();
      if (!meta || meta.version !== version) {
        throw new Error(
          "versao do pacote (" + (meta && meta.version) + ") diverge da do Agent (" + version + ")"
        );
      }
      const files = Array.isArray(meta.manifest && meta.manifest.files) ? meta.manifest.files : [];
      const notifierFile = files.find((x) => x.name === "MonitorTI-Notifier.exe");
      if (!notifierFile) throw new Error("Notifier ausente no manifest");
      const agentFile = files.find((x) => x.name === "MonitorTI-Agent.exe");
      if (!meta.packageName) throw new Error("release sem pacote");
      if (!meta.packageSha256) throw new Error("release sem SHA do pacote");
      if (meta.packageSize == null) throw new Error("release sem tamanho do pacote");
      expectedReleaseMeta = {
        version: meta.version,
        packageName: meta.packageName,
        packageSha256: meta.packageSha256,
        packageSize: meta.packageSize,
        manifest: meta.manifest,
        agentSha256: agentFile ? agentFile.sha256 : null,
        agentSize: agentFile ? agentFile.size : null,
        notifierSha256: notifierFile.sha256,
        notifierSize: notifierFile.size,
      };
      return expectedReleaseMeta;
    })();

    try {
      return await expectedReleaseMetaPromise;
    } finally {
      expectedReleaseMetaPromise = null;
    }
  }

  function validateInstalledNotifier() {
    return getReadinessStatus().status === "READY";
  }

  function readLocalIntegrity() {
    try {
      const file = path.join(getAppDir(), LOCAL_INTEGRITY_FILE);
      const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!metadata || typeof metadata.notifierSha256 !== "string") return null;
      return metadata;
    } catch (e) {
      return null;
    }
  }

  function getReadinessStatus() {
    const existing = findNotifierExe();
    if (!existing) return { status: "NOT_INSTALLED", path: null };
    const metadata = readLocalIntegrity();
    if (!metadata) return { status: "LOCAL_METADATA_MISSING", path: existing };
    try {
      const actual = sha256File(existing).toLowerCase();
      if (actual !== metadata.notifierSha256.toLowerCase()) {
        return { status: "INTEGRITY_FAILED", path: existing };
      }
    } catch (e) {
      return { status: "INTEGRITY_FAILED", path: existing };
    }
    return { status: "READY", path: existing, version: metadata.version || null };
  }

  function loadCache() {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      return c && typeof c === "object" ? c : {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(c) {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
    } catch (e) {
      logEvent("aviso: falha ao salvar notice-cache: " + e.message);
    }
  }

  function pruneCache(c) {
    const cut = Date.now() - CACHE_TTL_MS;
    let changed = false;
    for (const k of Object.keys(c)) {
      if (!c[k] || !c[k].ts || c[k].ts < cut) {
        delete c[k];
        changed = true;
      }
    }
    return changed;
  }

  function findNotifierExe() {
    const candidates = [
      path.join(getAppDir(), "MonitorTI-Notifier.exe"),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return c;
      } catch (e) {}
    }
    return null;
  }

  // Indica se o Notifier está presente e pode exibir avisos.
  function isNotifierReady() {
    return validateInstalledNotifier();
  }

  function writePayload(d, tmpFile) {
    fs.mkdirSync(NOTICES_DIR, { recursive: true });
    const data = {
      noticeDeliveryId: d.noticeDeliveryId,
      title: d.title || "",
      message: d.message || "",
      level: d.level || "",
      scheduledAt: d.scheduledAt || "",
      serverTime: d.serverTime || new Date().toISOString(),
    };
    fs.writeFileSync(tmpFile, JSON.stringify(data), "utf8");
    // Permite que o Notifier (contexto do usuário) leia o arquivo temporário.
    try {
      execFileSync("icacls", [tmpFile, "/grant", "*S-1-5-32-545:(R)", "/Q"], { stdio: "ignore" });
    } catch (e) {
      logEvent("aviso: nao foi possivel ajustar ACL do payload: " + e.message);
    }
  }

  function handleNoticeShow(ws, msg) {
    const d = normalizeNoticeShowPayload(msg);
    if (!d) {
      logEvent("notice_show rejeitado: payload invalido");
      return;
    }
    const id = d.noticeDeliveryId;
    const cache = loadCache();
    let changed = pruneCache(cache);
    if (cache[id] && cache[id].state === "CONFIRMADO") {
      // Já confirmado: re-sincroniza com o servidor e não exibe de novo.
      try {
        ws.send(JSON.stringify({ type: "notice_acknowledged", data: { noticeDeliveryId: id, deviceId: getDeviceId() } }));
      } catch (e) {}
      saveCache(cache);
      return;
    }
    if (inProgress.has(id) || queueSet.has(id)) {
      logEvent("notice_show duplicado ignorado: " + id);
      return;
    }
    queue.push(d);
    queueSet.add(id);
    if (changed) saveCache(cache);
    processQueue(ws);
  }

  function processQueue(ws) {
    if (inProgress.size > 0) return; // uma janela por vez
    const d = queue.shift();
    if (!d) return;
    queueSet.delete(d.noticeDeliveryId);
    showNotice(ws, d);
  }

  function showNotice(ws, d) {
    const id = d.noticeDeliveryId;
    const pipeName = PIPE_PREFIX + id;
    const pipePath = "\\\\.\\pipe\\" + pipeName;
    const tmpFile = path.join(NOTICES_DIR, id + ".json");
    writePayload(d, tmpFile);

    const exe = findNotifierExe();
    if (!isNotifierReady()) {
      logEvent("MonitorTI-Notifier.exe nao validado; aviso nao exibido: " + id);
      if (!exe) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
      queueSet.delete(id);
      ensureNotifierPresent();
      return;
    }

    if (!exe) {
      logEvent("MonitorTI-Notifier.exe nao encontrado; aviso nao exibido: " + id);
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      queueSet.delete(id);
      return;
    }

    let cleaned = false;
    let receivedTimer = null;
    let server = null;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (receivedTimer) clearTimeout(receivedTimer);
      try { if (server) server.close(); } catch (e) {}
      try { fs.unlinkSync(tmpFile); } catch (e) {}
      inProgress.delete(id);
      processQueue(ws);
    }

    server = net.createServer((sock) => {
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("data", (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          if (line === "received") {
            const c = loadCache();
            c[id] = { state: "EXIBIDO", ts: Date.now() };
            saveCache(c);
            try {
              ws.send(JSON.stringify({ type: "notice_received", data: { noticeDeliveryId: id, deviceId: getDeviceId() } }));
            } catch (e) {}
          } else if (line === "acknowledged") {
            const c = loadCache();
            c[id] = { state: "CONFIRMADO", ts: Date.now() };
            saveCache(c);
            try {
              ws.send(JSON.stringify({ type: "notice_acknowledged", data: { noticeDeliveryId: id, deviceId: getDeviceId() } }));
            } catch (e) {}
            cleanup();
          }
        }
      });
      sock.on("error", () => {});
      sock.on("close", () => {
        // Fechamento sem "acknowledged": mantém PENDENTE/EXIBIDO (re-exibe depois).
        cleanup();
      });
    });

    server.on("error", (err) => {
      logEvent("pipe erro (" + pipeName + "): " + err.message);
      cleanup();
    });

    server.listen(pipePath, () => {
      inProgress.set(id, { server });
      receivedTimer = setTimeout(() => {
        logEvent("timeout esperando 'received' do Notifier: " + id);
        cleanup();
      }, RECEIVED_TIMEOUT_MS);

      launchNotifier(exe, pipeName, tmpFile, (err, marker) => {
        if (!err) return;
        if (marker === "NO_ACTIVE_SESSION") {
          logEvent("sem sessao interativa ativa; aviso mantido PENDENTE: " + id);
        } else if (marker === "FALLBACK") {
          logEvent("lancamento do Notifier via fallback (sessao atual): " + id);
        } else {
          logEvent("falha ao lancar Notifier: " + (marker || err.message) + " : " + id);
        }
        cleanup();
      });
    });
  }

  function launchNotifier(exe, pipeName, payloadFile, cb) {
    // O Agent apenas dispara o Notifier; o proprio Notifier promove o processo
    // para a sessao interativa do usuario via WTS APIs (CreateProcessAsUser),
    // evitando exibir UI em Session 0.
    const args = ["--pipe", pipeName, "--payload", payloadFile];
    try {
      spawn(exe, args, { detached: false, stdio: "ignore", windowsHide: false });
    } catch (e) {
      return cb(e);
    }
    cb(null);
  }

  function start(ws) {
    // Na inicialização, re-exibe avisos exibidos mas não confirmados.
    const cache = loadCache();
    if (pruneCache(cache)) saveCache(cache);
    for (const id of Object.keys(cache)) {
      if (cache[id] && cache[id].state === "EXIBIDO") {
        const d = cache[id].payload || { noticeDeliveryId: id };
        d.noticeDeliveryId = id;
        if (!queueSet.has(id) && !inProgress.has(id)) {
          queue.push(d);
          queueSet.add(id);
        }
      }
    }
    if (queue.length) processQueue(ws);
  }

  // Após a transição 1.0.1 -> 1.1.0 (via fluxo legado de arquivo único), o
  // novo Agent pode encontrar um Notifier stale; ele só é considerado pronto
  // quando o SHA local confere com a release da própria versão do Agent.
  async function ensureNotifierPresent() {
    if (ensureRunning) return;
    ensureRunning = true;
    try {
      const meta = await loadExpectedReleaseMeta();
      const existing = findNotifierExe();
      if (existing) {
        const localSha = sha256File(existing);
        if (localSha.toLowerCase() === String(meta.notifierSha256).toLowerCase()) {
          logEvent("Notifier presente e validado: " + existing);
          resetRetryBackoff();
          if (typeof onNotifierReady === "function") onNotifierReady();
          return;
        }
        logEvent("Notifier stale/sha invalido; tentando substituir...");
      } else {
        logEvent("Notifier ausente; tentando obter do pacote no servidor...");
      }
      await fetchNotifier(meta);
      resetRetryBackoff();
      if (typeof onNotifierReady === "function") onNotifierReady();
    } catch (e) {
      logEvent("aviso: falha ao obter Notifier: " + e.message);
      scheduleRetry(e.message);
    } finally {
      ensureRunning = false;
    }
  }

  async function fetchNotifier(meta) {
    const releaseMeta = meta || (await loadExpectedReleaseMeta());
    const base = baseHttpUrl();
    if (!base) throw new Error("URL do servidor indisponivel");
    const zipRes = await fetch(base + "/api/agent/releases/" + version + "/package");
    if (!zipRes.ok) throw new Error("pacote HTTP " + zipRes.status);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mti-nf-"));
    const zipPath = path.join(tmpDir, "pkg.zip");
    const buf = Buffer.from(await zipRes.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
    const zipSha = crypto.createHash("sha256").update(buf).digest("hex");
    if (zipSha.toLowerCase() !== String(releaseMeta.packageSha256).toLowerCase()) {
      throw new Error("SHA-256 do pacote nao confere");
    }
    const outDir = path.join(tmpDir, "out");
    fs.mkdirSync(outDir, { recursive: true });
    await extractZip(zipPath, outDir);
    const manPath = path.join(outDir, "manifest.json");
    if (!fs.existsSync(manPath)) throw new Error("manifest ausente no pacote");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    const f = (man.files || []).find((x) => x.name === "MonitorTI-Notifier.exe");
    if (!f) throw new Error("Notifier ausente no manifest");
    const notifPath = path.join(outDir, "MonitorTI-Notifier.exe");
    if (!fs.existsSync(notifPath)) throw new Error("Notifier ausente no pacote");
    const actual = crypto.createHash("sha256").update(fs.readFileSync(notifPath)).digest("hex");
    if (actual.toLowerCase() !== String(f.sha256).toLowerCase()) {
      throw new Error("SHA do Notifier nao confere");
    }
    const dest = path.join(getAppDir(), "MonitorTI-Notifier.exe");
    fs.copyFileSync(notifPath, dest);
    const installedSha = sha256File(dest);
    if (installedSha.toLowerCase() !== String(f.sha256).toLowerCase()) {
      throw new Error("SHA do Notifier instalado nao confere");
    }
    fs.writeFileSync(path.join(getAppDir(), LOCAL_INTEGRITY_FILE), JSON.stringify({
      version: releaseMeta.version,
      notifierSha256: f.sha256,
      notifierSize: f.size || fs.statSync(dest).size
    }, null, 2));
    logEvent("Notifier obtido e validado: " + dest);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const p = spawn("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("tar exit " + code))));
    });
  }

  return { handleNoticeShow, start, ensureNotifierPresent, isNotifierReady, getReadinessStatus };
}

module.exports = { createNotifier, normalizeNoticeShowPayload, LOCAL_INTEGRITY_FILE };
