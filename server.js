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
const backup = require("./backup.js");
const mailer = require("./mailer.js");

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

const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
const RESET_TTL_MS = 60 * 60 * 1000;         // 1 hour
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;   // 1 day

/* Email verification is only enforced when mail can actually reach people;
 * otherwise nobody could ever verify and sharing would break. */
function verificationRequired() {
  const explicit = process.env.REQUIRE_EMAIL_VERIFICATION;
  if (explicit !== undefined) return explicit === "true";
  return mailer.isConfigured();
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".gpx": "application/gpx+xml",
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

/* ---------- one-time tokens (password reset, email verification) ----------
 * Only the SHA-256 of a token is stored, so a leaked tokens.json can't be
 * used to reset anyone's password. Tokens are single-use and expire. */

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readTokens() {
  const all = readJson(TOKENS_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const [k, v] of Object.entries(all)) {
    if (!v || v.expiresAt < now) { delete all[k]; changed = true; }
  }
  if (changed) { try { writeJson(TOKENS_FILE, all); } catch { /* best effort */ } }
  return all;
}

function issueToken(kind, userId, ttlMs) {
  const token = crypto.randomBytes(32).toString("hex");
  const all = readTokens();
  // one live token per kind per user, so an old link stops working
  for (const [k, v] of Object.entries(all)) {
    if (v.userId === userId && v.kind === kind) delete all[k];
  }
  all[hashToken(token)] = { kind, userId, expiresAt: Date.now() + ttlMs };
  writeJson(TOKENS_FILE, all);
  return token;
}

function consumeToken(kind, token) {
  if (typeof token !== "string" || token.length < 32) return null;
  const all = readTokens();
  const key = hashToken(token);
  const rec = all[key];
  if (!rec || rec.kind !== kind || rec.expiresAt < Date.now()) return null;
  delete all[key];
  writeJson(TOKENS_FILE, all);
  return rec.userId;
}

function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || "http";
  return `${proto}://${req.headers.host}`;
}

async function sendVerificationEmail(req, user) {
  const token = issueToken("verify", user.id, VERIFY_TTL_MS);
  const link = `${appUrl(req)}/?verify=${token}`;
  await mailer.send({
    to: user.email,
    subject: "Confirm your email — Marathon Trainer",
    text: `Confirm this address to finish setting up your account:\n\n${link}\n\n` +
      `The link works for 24 hours. If you didn't sign up, ignore this email.`,
  });
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
    const user = {
      id,
      email,
      salt,
      passwordHash: hashPassword(password, salt),
      // with no mail provider nobody could ever confirm, so don't pretend to
      emailVerified: !verificationRequired(),
      createdAt: new Date().toISOString(),
    };
    writeJson(userFile(id), user);
    index[email] = id;
    writeJson(USERS_INDEX_FILE, index);

    if (verificationRequired()) {
      sendVerificationEmail(req, user).catch((e) =>
        console.error("[verify] mail failed:", e.message));
    }

    const token = createSession(id);
    sendJson(res, 200, {
      user: { id, email, emailVerified: user.emailVerified, verificationRequired: verificationRequired() },
    }, {
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
    sendJson(res, 200, {
      user: {
        id: user.id, email: user.email,
        emailVerified: user.emailVerified !== false,
        verificationRequired: verificationRequired(),
      },
    }, { "Set-Cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000) });
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
  sendJson(res, 200, {
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified !== false,
      verificationRequired: verificationRequired(),
    },
  });
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

/* ---------- password reset & email verification ---------- */

function handleForgot(req, res) {
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, async (body) => {
    const email = String(body.email || "").trim().toLowerCase();
    // always the same answer: never confirm whether an address has an account
    const done = () => sendJson(res, 200, { ok: true });
    const index = readJson(USERS_INDEX_FILE, {});
    const id = index[email];
    const user = id && readJson(userFile(id), null);
    if (!user) return done();
    try {
      const token = issueToken("reset", user.id, RESET_TTL_MS);
      await mailer.send({
        to: user.email,
        subject: "Reset your password — Marathon Trainer",
        text: `Someone asked to reset the password for this account.\n\n` +
          `${appUrl(req)}/?reset=${token}\n\n` +
          `The link works for one hour and can be used once. If this wasn't ` +
          `you, ignore this email — your password is unchanged.`,
      });
    } catch (e) {
      console.error("[reset] mail failed:", e.message);
    }
    done();
  });
}

function handleResetPassword(req, res) {
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, (body) => {
    const password = String(body.password || "");
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 200) {
      return sendJson(res, 400, { error: "password_too_short" });
    }
    const userId = consumeToken("reset", String(body.token || ""));
    if (!userId) return sendJson(res, 400, { error: "invalid_or_expired_token" });
    const user = readJson(userFile(userId), null);
    if (!user) return sendJson(res, 400, { error: "invalid_or_expired_token" });

    const salt = crypto.randomBytes(16).toString("hex");
    user.salt = salt;
    user.passwordHash = hashPassword(password, salt);
    // reaching the inbox proves ownership, so this also verifies the address
    user.emailVerified = true;
    writeJson(userFile(userId), user);

    // a reset may be a recovery from compromise: drop every existing session
    let dropped = false;
    for (const [tok, s] of Object.entries(sessions)) {
      if (s.userId === userId) { delete sessions[tok]; dropped = true; }
    }
    if (dropped) writeJson(SESSIONS_FILE, sessions);

    const token = createSession(userId);
    sendJson(res, 200, {
      user: {
        id: user.id, email: user.email,
        emailVerified: true, verificationRequired: verificationRequired(),
      },
    }, { "Set-Cookie": sessionCookie(req, token, SESSION_TTL_MS / 1000) });
  });
}

function handleVerifyEmail(req, res) {
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  readJsonBody(req, res, MAX_AUTH_BODY_BYTES, (body) => {
    const userId = consumeToken("verify", String(body.token || ""));
    if (!userId) return sendJson(res, 400, { error: "invalid_or_expired_token" });
    const user = readJson(userFile(userId), null);
    if (!user) return sendJson(res, 400, { error: "invalid_or_expired_token" });
    user.emailVerified = true;
    writeJson(userFile(userId), user);
    sendJson(res, 200, { ok: true, email: user.email });
  });
}

function handleResendVerification(req, res) {
  const session = sessionFor(req);
  if (!session) return sendJson(res, 401, { error: "not_logged_in" });
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  const user = readJson(userFile(session.userId), null);
  if (!user) return sendJson(res, 401, { error: "not_logged_in" });
  if (user.emailVerified) return sendJson(res, 200, { ok: true, alreadyVerified: true });
  sendVerificationEmail(req, user)
    .then(() => sendJson(res, 200, { ok: true }))
    .catch((e) => {
      console.error("[verify] mail failed:", e.message);
      sendJson(res, 500, { error: "mail_failed" });
    });
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
    // an unverified signup could be squatting someone else's address
    const recipient = readJson(userFile(recipientId), null);
    if (verificationRequired() && recipient && recipient.emailVerified === false) {
      return sendJson(res, 409, { error: "recipient_unverified" });
    }
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

/* ---------- admin: pull a snapshot off the box ----------
 * Disabled unless ADMIN_TOKEN is set. Lets an external scheduler (see
 * .github/workflows/backup.yml) keep copies somewhere the volume isn't. */
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function handleAdminBackup(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return sendJson(res, 404, { error: "not_found" }); // feature off
  if (rateLimited(req)) return sendJson(res, 429, { error: "too_many_attempts" });
  const auth = req.headers.authorization || "";
  const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!supplied || !timingSafeEqualStr(supplied, token)) {
    return sendJson(res, 401, { error: "unauthorized" });
  }
  let snapshot;
  try {
    snapshot = backup.writeSnapshot(DATA_DIR, {
      keep: Number(process.env.BACKUP_KEEP) || undefined,
    });
  } catch (e) {
    return sendJson(res, 500, { error: "backup_failed" });
  }
  const body = fs.readFileSync(snapshot.file);
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${path.basename(snapshot.file)}"`,
    "Cache-Control": "no-store",
    "X-Backup-Counts": JSON.stringify(snapshot.counts),
  });
  res.end(body);
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
  "GET /api/admin/backup": handleAdminBackup,
  "POST /api/forgot": handleForgot,
  "POST /api/reset": handleResetPassword,
  "POST /api/verify": handleVerifyEmail,
  "POST /api/verify/resend": handleResendVerification,
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
  // on-volume snapshots with rotation; set BACKUP_INTERVAL_HOURS=0 to disable
  const hours = process.env.BACKUP_INTERVAL_HOURS === undefined
    ? 24 : Number(process.env.BACKUP_INTERVAL_HOURS);
  if (hours > 0) {
    backup.startScheduledBackups(DATA_DIR, {
      hours, keep: Number(process.env.BACKUP_KEEP) || undefined,
    });
    console.log(`[backup] snapshots every ${hours}h into ${backup.backupsDir(DATA_DIR)}` +
      (process.env.ADMIN_TOKEN ? " · GET /api/admin/backup enabled" : " · set ADMIN_TOKEN to pull them off-box"));
  }
});
