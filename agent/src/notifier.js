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

function createNotifier(opts) {
  const { configDir, getAppDir, getDeviceId, getWs, logEvent, version, getServerHttpBase, onNotifierReady } = opts;

  const NOTICES_DIR = path.join(configDir, "notices");
  const CACHE_FILE = path.join(configDir, "notice-cache.json");
  const inProgress = new Map();
  const queue = [];
  const queueSet = new Set();

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
      path.join(__dirname, "..", "..", "release", "agent-test", "MonitorTI-Notifier.exe"),
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
    return !!findNotifierExe();
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
    const d = (msg && msg.data) || {};
    const id = d.noticeDeliveryId;
    if (!UUID_RE.test(id || "")) {
      logEvent("notice_show ignorado: noticeDeliveryId invalido");
      return;
    }
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
    const autoAck = process.env.MTI_TEST_AUTO_ACK === "1";
    const args = ["--pipe", pipeName, "--payload", payloadFile];
    if (autoAck) args.push("--auto-ack");
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
  // novo Agent pode não ter o Notifier. Ele se obtém do pacote no servidor.
  function ensureNotifierPresent() {
    try {
      const existing = findNotifierExe();
      if (existing) {
        logEvent("Notifier presente: " + existing);
        return;
      }
      logEvent("Notifier ausente; tentando obter do pacote no servidor...");
      fetchNotifier().catch((e) => logEvent("aviso: falha ao obter Notifier: " + e.message));
    } catch (e) {
      logEvent("aviso: ensureNotifierPresent: " + e.message);
    }
  }

  async function fetchNotifier() {
    const httpBase = (getServerHttpBase && getServerHttpBase()) || "";
    const base = httpBase.replace(/^ws/i, "http").replace(/^wss/i, "https");
    if (!base) throw new Error("URL do servidor indisponivel");
    const metaRes = await fetch(base + "/api/agent/releases/latest");
    if (!metaRes.ok) throw new Error("metadata HTTP " + metaRes.status);
    const meta = await metaRes.json();
    if (!meta || meta.version !== version) {
      throw new Error("versao do pacote (" + (meta && meta.version) + ") diverge da do Agent (" + version + ")");
    }
    if (!meta.packageName) throw new Error("release sem pacote");
    const zipRes = await fetch(base + "/api/agent/releases/" + version + "/package");
    if (!zipRes.ok) throw new Error("pacote HTTP " + zipRes.status);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mti-nf-"));
    const zipPath = path.join(tmpDir, "pkg.zip");
    const buf = Buffer.from(await zipRes.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
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
    logEvent("Notifier obtido e validado: " + dest);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    if (typeof onNotifierReady === "function") onNotifierReady();
  }

  function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
      const p = spawn("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error("tar exit " + code))));
    });
  }

  return { handleNoticeShow, start, ensureNotifierPresent, isNotifierReady };
}

module.exports = { createNotifier };
