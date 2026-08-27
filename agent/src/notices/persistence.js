const fs = require("fs");
const path = require("path");

const STATE_VERSION = 1;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

function getStateDir(configDir) {
  return path.join(configDir, "state");
}

function getStatePath(configDir) {
  return path.join(getStateDir(configDir), "notices.json");
}

function getCorruptPath(configDir, ts = Date.now()) {
  return path.join(getStateDir(configDir), `notices.corrupt-${ts}.json`);
}

function ensureStateDir(configDir) {
  fs.mkdirSync(getStateDir(configDir), { recursive: true });
}

function emptyState() {
  return {
    version: STATE_VERSION,
    deliveries: {},
    queue: [],
    dedup: {},
    updatedAt: new Date().toISOString()
  };
}

function isFinalState(state) {
  return ["ACKNOWLEDGED", "EXPIRED", "FAILED"].includes(String(state || "").toUpperCase());
}

function pruneState(state, now = Date.now()) {
  if (!state || typeof state !== "object") return emptyState();
  const next = {
    version: STATE_VERSION,
    deliveries: {},
    queue: Array.isArray(state.queue) ? state.queue.filter(Boolean) : [],
    dedup: {},
    updatedAt: new Date(now).toISOString()
  };

  const deliveries = state.deliveries && typeof state.deliveries === "object" ? state.deliveries : {};
  for (const [id, delivery] of Object.entries(deliveries)) {
    if (!delivery || typeof delivery !== "object") continue;
    const updatedAtRaw = delivery.updatedAt || delivery.createdAt || 0;
    const updatedAt = typeof updatedAtRaw === "number" ? updatedAtRaw : Date.parse(updatedAtRaw);
    if (isNaN(updatedAt)) continue;
    if (isFinalState(delivery.state) && now - updatedAt > STATE_RETENTION_MS) continue;
    next.deliveries[id] = delivery;
  }

  const dedup = state.dedup && typeof state.dedup === "object" ? state.dedup : {};
  for (const [id, entry] of Object.entries(dedup)) {
    if (!entry || typeof entry !== "object") continue;
    const tsRaw = entry.updatedAt || entry.ts || 0;
    const ts = typeof tsRaw === "number" ? tsRaw : Date.parse(tsRaw);
    if (isNaN(ts)) continue;
    if (isFinalState(entry.state) && now - ts > STATE_RETENTION_MS) continue;
    next.dedup[id] = entry;
  }

  next.queue = next.queue.filter((id) => !!next.deliveries[id]);
  return next;
}

function validateStateShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (Number(raw.version) !== STATE_VERSION) return null;
  const state = emptyState();
  state.queue = Array.isArray(raw.queue) ? raw.queue.filter((id) => typeof id === "string" && id.trim()) : [];
  state.deliveries = raw.deliveries && typeof raw.deliveries === "object" ? raw.deliveries : {};
  state.dedup = raw.dedup && typeof raw.dedup === "object" ? raw.dedup : {};
  state.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : state.updatedAt;
  return pruneState(state);
}

function loadNoticeState(configDir, logEvent) {
  const filePath = getStatePath(configDir);
  try {
    if (!fs.existsSync(filePath)) return emptyState();
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const validated = validateStateShape(parsed);
    if (!validated) {
      throw new Error("schema invalido");
    }
    return validated;
  } catch (err) {
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, getCorruptPath(configDir));
      }
    } catch (renameErr) {
      if (typeof logEvent === "function") logEvent("falha ao quarentenar notices.json: " + renameErr.message);
    }
    if (typeof logEvent === "function") logEvent("state notices corrompido; iniciando vazio: " + err.message);
    return emptyState();
  }
}

function writeAtomic(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  const content = JSON.stringify(payload, null, 2);
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, content, "utf8");
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  fs.renameSync(tmp, filePath);
}

function saveNoticeState(configDir, state) {
  const filePath = getStatePath(configDir);
  const normalized = pruneState(state);
  normalized.version = STATE_VERSION;
  normalized.updatedAt = new Date().toISOString();
  writeAtomic(filePath, normalized);
  return filePath;
}

module.exports = {
  STATE_VERSION,
  STATE_RETENTION_MS,
  getStateDir,
  getStatePath,
  getCorruptPath,
  emptyState,
  pruneState,
  loadNoticeState,
  saveNoticeState,
  isFinalState,
  writeAtomic
};
