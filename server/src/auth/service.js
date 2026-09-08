const crypto = require("crypto");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const COOKIE_NAME = "ht_session";

function createPasswordHash(password, options = {}) {
  const salt = options.salt || crypto.randomBytes(16).toString("hex");
  const N = 16384;
  const r = 8;
  const p = 1;
  const derived = crypto.scryptSync(String(password), salt, 64, { N, r, p, maxmem: 32 * 1024 * 1024 }).toString("hex");
  return `scrypt$${N}$${r}$${p}$${salt}$${derived}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, nRaw, rRaw, pRaw, salt, expectedHex] = String(encoded || "").split("$");
    if (algorithm !== "scrypt" || !salt || !/^[0-9a-f]{128}$/i.test(expectedHex || "")) return false;
    const N = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (![N, r, p].every(Number.isInteger) || N < 1024 || r <= 0 || p <= 0 || N > 1 << 20) return false;
    const expected = Buffer.from(expectedHex, "hex");
    const actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: 32 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function isValidPasswordHash(encoded) {
  const parts = String(encoded || "").split("$");
  return parts.length === 6 && parts[0] === "scrypt" && /^[0-9a-f]{32}$/i.test(parts[4]) && /^[0-9a-f]{128}$/i.test(parts[5]);
}

function parseCookies(header) {
  const result = {};
  for (const item of String(header || "").split(";")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) {
      try { result[key] = decodeURIComponent(value); } catch { result[key] = ""; }
    }
  }
  return result;
}

function createAuthService(options = {}) {
  const username = String(options.username !== undefined ? options.username : process.env.HT_ADMIN_USERNAME || "").trim();
  const passwordHash = String(options.passwordHash !== undefined ? options.passwordHash : process.env.HT_ADMIN_PASSWORD_HASH || "").trim();
  const viewerUsername = String(options.viewerUsername !== undefined ? options.viewerUsername : process.env.HT_VIEWER_USERNAME || "").trim();
  const viewerPasswordHash = String(options.viewerPasswordHash !== undefined ? options.viewerPasswordHash : process.env.HT_VIEWER_PASSWORD_HASH || "").trim();
  const users = [
    ...(username && isValidPasswordHash(passwordHash) ? [{ username, passwordHash, role: "ADMIN" }] : []),
    ...(viewerUsername && isValidPasswordHash(viewerPasswordHash) && viewerUsername !== username ? [{ username: viewerUsername, passwordHash: viewerPasswordHash, role: "VIEWER" }] : [])
  ];
  const now = options.now || (() => Date.now());
  const randomBytes = options.randomBytes || ((size) => crypto.randomBytes(size));
  const sessions = new Map();
  const attempts = new Map();

  function cleanup() {
    const timestamp = now();
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id);
    for (const [ip, record] of attempts) if (record.resetAt <= timestamp) attempts.delete(ip);
  }

  function isConfigured() {
    return users.length > 0;
  }

  function rateLimit(ip) {
    cleanup();
    const record = attempts.get(ip);
    if (!record) return { limited: false };
    if (record.attempts >= RATE_LIMIT_MAX_ATTEMPTS) return { limited: true, retryAfter: Math.max(1, Math.ceil((record.resetAt - now()) / 1000)) };
    return { limited: false };
  }

  function recordFailure(ip) {
    const timestamp = now();
    const current = attempts.get(ip);
    if (!current || current.resetAt <= timestamp) {
      attempts.set(ip, { attempts: 1, resetAt: timestamp + RATE_LIMIT_WINDOW_MS });
    } else {
      current.attempts += 1;
    }
  }

  function login(input = {}) {
    const ip = String(input.ip || "unknown");
    const limited = rateLimit(ip);
    if (limited.limited) return { ok: false, status: 429, code: "RATE_LIMITED", retryAfter: limited.retryAfter };
    const account = users.find((item) => item.username === String(input.username || "").trim());
    const valid = isConfigured() && account && String(input.password || "") !== "" && verifyPassword(input.password, account.passwordHash);
    if (!valid) {
      recordFailure(ip);
      return { ok: false, status: 401, code: "INVALID_CREDENTIALS" };
    }
    attempts.delete(ip);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, { username: account.username, role: account.role, createdAt: now(), expiresAt: now() + SESSION_TTL_MS });
    return { ok: true, sessionId: id, expiresAt: now() + SESSION_TTL_MS, username: account.username, role: account.role };
  }

  function getSession(sessionId) {
    cleanup();
    const session = sessions.get(String(sessionId || ""));
    return session && session.expiresAt > now() ? { ...session } : null;
  }

  function getRequestSession(req) {
    return getSession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  }

  function logout(sessionId) {
    sessions.delete(String(sessionId || ""));
  }

  function cookieOptions(secure = String(process.env.HT_AUTH_COOKIE_SECURE || "").toLowerCase() === "true") {
    return `${COOKIE_NAME}=__VALUE__; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
  }

  function sessionCookie(sessionId, secure) {
    return cookieOptions(secure).replace("__VALUE__", encodeURIComponent(sessionId));
  }

  function expiredCookie(secure) {
    return `${cookieOptions(secure).replace("__VALUE__", "")}; Max-Age=0`;
  }

  return {
    COOKIE_NAME,
    SESSION_TTL_MS,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_ATTEMPTS,
    createPasswordHash,
    isConfigured,
    login,
    getRequestSession,
    logout,
    sessionCookie,
    expiredCookie,
    _sessions: sessions
  };
}

module.exports = { createAuthService, createPasswordHash, verifyPassword, parseCookies, SESSION_TTL_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_ATTEMPTS, COOKIE_NAME };
