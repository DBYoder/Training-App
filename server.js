/* Static file server + accounts/data API for deployment (e.g. Railway).
 * No dependencies — serves the app files, binds to the PORT env var, and
 * stores users, sessions, and per-user training data as JSON files in
 * DATA_DIR (attach a persistent volume there in production; defaults to
 * ./data).
 *
 * Auth model: email + password (scrypt-hashed), session token in an
 * HttpOnly SameSite=Lax cookie. Each user's training data (plans,
 * schedules, journals) is a single JSON blob under /api/data.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 16 * 1024;
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MIN_PASSWORD_LENGTH = 8;

const USERS_INDEX_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const userFile = (id) => path.join(DATA_DIR, "users", `${id}.json`);
const userDataFile = (id) => path.join(DATA_DIR, "userdata", `${id}.json`);
const inboxFile = (id) => path.join(DATA_DIR, "inbox", `${id}.json`);

const MAX_SHARE_BYTES = 1024 * 1024;
const MAX_INBOX_ITEMS = 50;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

/* ---------- tiny JSON file store (atomic writes) ---------- */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

/* ---------- passwords & sessions ---------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}

function verifyPassword(password, salt, expectedHex) {
  const actual = Buffer.from(hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

let sessions = readJson(SESSIONS_FILE, {});

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const token of Object.keys(sessions)) {
    if (sessions[token].expiresAt < now) {
      delete sessions[token];
      changed = true;
    }
  }
  if (changed) writeJson(SESSIONS_FILE, sessions);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions[token] = { userId, expiresAt: Date.now() + SESSION_TTL_MS };
  writeJson(SESSIONS_FILE, sessions);
  return token;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function sessionFor(req) {
  pruneSessions();
  const token = parseCookies(req).session;
  const s = token && sessions[token];
  return s && s.expiresAt > Date.now() ? { token, userId: s.userId } : null;
}

function sessionCookie(req, token, maxAgeSeconds) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/* ---------- rate limiting for auth endpoints ---------- */

const authAttempts = new Map(); // ip -> {count, resetAt}
const AUTH_LIMIT = 30;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

function rateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress || "unknown";
  const now = Date.now();
  let rec = authAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    rec = { count: 0, resetAt: now + AUTH_WINDOW_MS };
    authAttempts.set(ip, rec);
  }
  rec.count++;
  if (authAttempts.size > 10000) authAttempts.clear(); // crude memory cap
  return rec.count > AUTH_LIMIT;
}

/* ---------- request helpers ---------- */

function sendJson(res, status, obj, extraHeaders) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req, res, limit, cb) {
  let body = "";
  let overflow = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > limit) {
      overflow = true;
      sendJson(res, 413, { error: "payload_too_large" });
      req.destroy();
    }
  });
  req.on("end", () => {
    if (overflow) return;
    try {
      cb(JSON.parse(body));
    } catch {
      sendJson(res, 400, { error: "invalid_json" });
    }
  });
}

/* ---------- API handlers ---------- */

function handleRegister(req, res) {
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, (body) => {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
      return sendJson(res, 400, { error: "invalid_email" });
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      return sendJson(res, 400, { error: "password_too_short" });
    }
    const index = readJson(USERS_INDEX_FILE, {});
    if (index[email]) return sendJson(res, 409, { error: "email_taken" });

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString("hex");
    writeJson(userFile(id), {
      id,
      email,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    });
    index[email] = id;
    writeJson(USERS_INDEX_FILE, index);

    const token = createSession(id);
    sendJson(res, 200, { user: { id, email } }, {
      "Set-Cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000),
    });
  });
}

function handleLogin(req, res) {
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, (body) => {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const index = readJson(USERS_INDEX_FILE, {});
    const id = index[email];
    const user = id && readJson(userFile(id), null);
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      return sendJson(res, 401, { error: "invalid_credentials" });
    }
    const token = createSession(user.id);
    sendJson(res, 200, { user: { id: user.id, email: user.email } }, {
      "Set-Cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000),
    });
  });
}

function handleLogout(req, res) {
  const session = sessionFor(req);
  if (session) {
    delete sessions[session.token];
    writeJson(SESSIONS_FILE, sessions);
  }
  sendJson(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
}

function handleMe(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });
  const user = readJson(userFile(session.userId), null);
  if (!user) return sendJson(res, 401, { error: "not_logged_in" });
  sendJson(res, 200, { user: { id: user.id, email: user.email } });
}

function handleData(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });

  if (req.method === "GET") {
    const record = readJson(userDataFile(session.userId), null);
    // no record yet is a normal state (first sync), not an error
    return sendJson(res, 200, record || { state: null });
  }

  if (req.method === "PUT") {
    return readJsonBody(req, res, MAX_STATE_BYTES, (body) => {
      const state = body && body.state;
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return sendJson(res, 400, { error: "invalid_state" });
      }
      const updatedAt = new Date().toISOString();
      try {
        writeJson(userDataFile(session.userId), { state, updatedAt });
      } catch {
        return sendJson(res, 500, { error: "write_failed" });
      }
      sendJson(res, 200, { ok: true, updatedAt });
    });
  }

  sendJson(res, 405, { error: "method_not_allowed" });
}

/* ---------- plan sharing (per-recipient inbox) ---------- */

function handleShareSend(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_SHARE_BYTES, (body) => {
    const email = String(body.email || "").trim().toLowerCase();
    const plan = body.plan;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return sendJson(res, 400, { error: "invalid_email" });
    }
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.weeks) ||
        !plan.weeks.length || plan.weeks.length > 60) {
      return sendJson(res, 400, { error: "invalid_plan" });
    }
    const index = readJson(USERS_INDEX_FILE, {});
    const recipientId = index[email];
    if (!recipientId) return sendJson(res, 404, { error: "recipient_not_found" });
    if (recipientId === session.userId) return sendJson(res, 400, { error: "cannot_share_with_self" });
    const inbox = readJson(inboxFile(recipientId), []);
    if (inbox.length >= MAX_INBOX_ITEMS) return sendJson(res, 409, { error: "inbox_full" });
    const sender = readJson(userFile(session.userId), null);
    inbox.push({
      id: crypto.randomUUID(),
      fromEmail: sender ? sender.email : "unknown",
      sharedAt: new Date().toISOString(),
      plan,
    });
    try {
      writeJson(inboxFile(recipientId), inbox);
    } catch {
      return sendJson(res, 500, { error: "write_failed" });
    }
    sendJson(res, 200, { ok: true });
  });
}

function handleSharesList(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });
  sendJson(res, 200, { shares: readJson(inboxFile(session.userId), []) });
}

function handleShareDismiss(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, (body) => {
    const id = String(body.id || "");
    const inbox = readJson(inboxFile(session.userId), []);
    const next = inbox.filter((s) => s.id !== id);
    try {
      writeJson(inboxFile(session.userId), next);
    } catch {
      return sendJson(res, 500, { error: "write_failed" });
    }
    sendJson(res, 200, { ok: true });
  });
}

const API_ROUTES = {
  "POST /api/register": handleRegister,
  "POST /api/login": handleLogin,
  "POST /api/logout": handleLogout,
  "GET /api/me": handleMe,
  "GET /api/data": handleData,
  "PUT /api/data": handleData,
  "POST /api/share": handleShareSend,
  "GET /api/shares": handleSharesList,
  "POST /api/shares/dismiss": handleShareDismiss,
};

/* ---------- static files ---------- */

function handleStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end("Method not allowed");
  }
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let filePath = path.normalize(path.join(ROOT, urlPath));

  // never serve outside the app directory, and never serve stored data
  if (!filePath.startsWith(ROOT) || filePath.startsWith(DATA_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (urlPath === "/" || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, "index.html");
  }

  // no-cache = browsers may store but MUST revalidate, so a redeploy is
  // picked up immediately (stale app.js against a new index.html bricks the
  // page); unchanged files still answer with a cheap 304
  const stat = fs.statSync(filePath);
  const lastModified = stat.mtime.toUTCString();
  const ims = req.headers["if-modified-since"];
  const headers = {
    "Cache-Control": "no-cache",
    "Last-Modified": lastModified,
  };
  if (ims && !Number.isNaN(Date.parse(ims)) &&
      Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(ims) / 1000)) {
    res.writeHead(304, headers);
    return res.end();
  }
  const ext = path.extname(filePath).toLowerCase();
  headers["Content-Type"] = MIME[ext] || "application/octet-stream";
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const route = API_ROUTES[`${req.method} ${pathname}`];
  if (route) return route(req, res);
  if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not_found" });
  handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Marathon Trainer listening on port ${PORT} (data dir: ${DATA_DIR})`);
});
