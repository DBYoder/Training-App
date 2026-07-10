/* Static file server + sync API for deployment (e.g. Railway).
 * No dependencies — serves the app files, binds to the PORT env var, and
 * stores synced training data as JSON files in DATA_DIR (attach a persistent
 * volume there in production; defaults to ./data).
 *
 * Sync model: the client sends a user-chosen sync code in the X-Sync-Code
 * header. The server never stores the code itself — data lives under its
 * SHA-256 hash, so the code acts as a bearer secret per training log.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAX_BODY_BYTES = 1024 * 1024;
const MIN_CODE_LENGTH = 8;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

function syncFilePath(code) {
  const id = crypto.createHash("sha256").update(code).digest("hex");
  return path.join(DATA_DIR, `${id}.json`);
}

function handleSync(req, res) {
  const code = (req.headers["x-sync-code"] || "").trim();
  if (code.length < MIN_CODE_LENGTH || code.length > 200) {
    return sendJson(res, 400, { error: "invalid_sync_code" });
  }
  const file = syncFilePath(code);

  if (req.method === "GET") {
    return fs.readFile(file, "utf8", (err, data) => {
      // no record yet is a normal state (first sync), not an error
      if (err) return sendJson(res, 200, { state: null });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  }

  if (req.method === "PUT") {
    let body = "";
    let overflow = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        overflow = true;
        sendJson(res, 413, { error: "payload_too_large" });
        req.destroy();
      }
    });
    req.on("end", () => {
      if (overflow) return;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "invalid_json" });
      }
      const state = parsed && parsed.state;
      if (!state || typeof state !== "object" ||
          (state.journal && typeof state.journal !== "object")) {
        return sendJson(res, 400, { error: "invalid_state" });
      }
      const updatedAt = new Date().toISOString();
      const record = JSON.stringify({ state, updatedAt });
      fs.mkdir(DATA_DIR, { recursive: true }, (err) => {
        if (err) return sendJson(res, 500, { error: "storage_unavailable" });
        // atomic write: temp file + rename, so a crash can't corrupt the record
        const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFile(tmp, record, (err) => {
          if (err) return sendJson(res, 500, { error: "write_failed" });
          fs.rename(tmp, file, (err) => {
            if (err) return sendJson(res, 500, { error: "write_failed" });
            sendJson(res, 200, { ok: true, updatedAt });
          });
        });
      });
    });
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
}

function handleStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    return res.end("Method not allowed");
  }
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  let filePath = path.normalize(path.join(ROOT, urlPath));

  // never serve outside the app directory, and never serve synced data
  if (!filePath.startsWith(ROOT) || filePath.startsWith(DATA_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (urlPath === "/" || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT, "index.html");
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname === "/api/sync") return handleSync(req, res);
  handleStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Marathon Trainer listening on port ${PORT} (data dir: ${DATA_DIR})`);
});
