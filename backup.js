/* Snapshot / restore for the data volume.
 *
 * Everything a user owns lives as JSON files under DATA_DIR. A volume loss is
 * the only unrecoverable failure this app has, so snapshots are:
 *   - taken on a schedule by the server (see startScheduledBackups)
 *   - written gzipped to DATA_DIR/backups with rotation
 *   - pullable off-box via GET /api/admin/backup (see server.js)
 *
 * Sessions are deliberately NOT included: they're ephemeral, and a leaked
 * backup should not hand anyone a live login.
 *
 * CLI:
 *   node backup.js                    snapshot now
 *   node backup.js --list             list snapshots
 *   node backup.js --restore <file>   restore (refuses unless --force)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SNAPSHOT_VERSION = 1;
const DEFAULT_KEEP = 14;

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readDirJson(dir) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out; // directory not created yet
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const parsed = readJsonFile(path.join(dir, name));
    if (parsed !== null) out[name.replace(/\.json$/, "")] = parsed;
  }
  return out;
}

/** Full logical snapshot of the volume, as a plain object. */
function createSnapshot(dataDir) {
  const snapshot = {
    version: SNAPSHOT_VERSION,
    createdAt: new Date().toISOString(),
    usersIndex: readJsonFile(path.join(dataDir, "users.json")) || {},
    users: readDirJson(path.join(dataDir, "users")),
    userdata: readDirJson(path.join(dataDir, "userdata")),
    inbox: readDirJson(path.join(dataDir, "inbox")),
  };
  snapshot.counts = {
    users: Object.keys(snapshot.users).length,
    userdata: Object.keys(snapshot.userdata).length,
    inbox: Object.keys(snapshot.inbox).length,
  };
  return snapshot;
}

function backupsDir(dataDir) {
  return path.join(dataDir, "backups");
}

/** Write a gzipped snapshot and prune old ones. Returns {file, bytes, counts}. */
function writeSnapshot(dataDir, { keep = DEFAULT_KEEP } = {}) {
  const snapshot = createSnapshot(dataDir);
  const dir = backupsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = snapshot.createdAt.replace(/[:.]/g, "-");
  const file = path.join(dir, `backup-${stamp}.json.gz`);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot)), { level: 9 });
  // atomic: temp file then rename, so a crash never leaves a truncated backup
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, file);
  pruneSnapshots(dataDir, keep);
  return { file, bytes: gz.length, counts: snapshot.counts };
}

function listSnapshots(dataDir) {
  const dir = backupsDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith("backup-") && n.endsWith(".json.gz"))
    .sort()
    .reverse() // newest first
    .map((n) => {
      const full = path.join(dir, n);
      return { name: n, file: full, bytes: fs.statSync(full).size };
    });
}

function pruneSnapshots(dataDir, keep = DEFAULT_KEEP) {
  const removed = [];
  for (const s of listSnapshots(dataDir).slice(keep)) {
    fs.unlinkSync(s.file);
    removed.push(s.name);
  }
  return removed;
}

function readSnapshot(file) {
  const raw = fs.readFileSync(file);
  const json = file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw;
  const snapshot = JSON.parse(json.toString("utf8"));
  if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(`unsupported snapshot version: ${snapshot && snapshot.version}`);
  }
  return snapshot;
}

/** Restore a snapshot over DATA_DIR. Existing files for the same ids are
 *  overwritten; unrelated files are left alone. Sessions are untouched. */
function restoreSnapshot(file, dataDir) {
  const snapshot = readSnapshot(file);
  const writeAll = (sub, map) => {
    const dir = path.join(dataDir, sub);
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, value] of Object.entries(map || {})) {
      // ids come from our own filenames, but never let one escape the dir
      if (!/^[A-Za-z0-9._-]+$/.test(id)) continue;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(value));
    }
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "users.json"), JSON.stringify(snapshot.usersIndex || {}));
  writeAll("users", snapshot.users);
  writeAll("userdata", snapshot.userdata);
  writeAll("inbox", snapshot.inbox);
  return snapshot.counts || {};
}

/** Periodic snapshots from inside the server process (Railway has no cron). */
function startScheduledBackups(dataDir, { hours = 24, keep = DEFAULT_KEEP } = {}) {
  if (!(hours > 0)) return null;
  const run = () => {
    try {
      const { file, bytes, counts } = writeSnapshot(dataDir, { keep });
      console.log(`[backup] ${path.basename(file)} — ${counts.users} users, ${(bytes / 1024).toFixed(1)} KiB`);
    } catch (e) {
      console.error("[backup] failed:", e.message);
    }
  };
  // one shortly after boot so a fresh deploy is covered, then on the interval
  const first = setTimeout(run, 60 * 1000);
  first.unref?.();
  const timer = setInterval(run, hours * 3600 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = {
  SNAPSHOT_VERSION,
  createSnapshot,
  writeSnapshot,
  listSnapshots,
  pruneSnapshots,
  readSnapshot,
  restoreSnapshot,
  startScheduledBackups,
  backupsDir,
};

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
  const args = process.argv.slice(2);
  if (args[0] === "--list") {
    const list = listSnapshots(dataDir);
    if (!list.length) console.log("no snapshots in " + backupsDir(dataDir));
    list.forEach((s) => console.log(`${s.name}  ${(s.bytes / 1024).toFixed(1)} KiB`));
  } else if (args[0] === "--restore") {
    const file = args[1];
    if (!file) {
      console.error("usage: node backup.js --restore <file> [--force]");
      process.exit(1);
    }
    if (!args.includes("--force")) {
      const snapshot = readSnapshot(file);
      console.error(
        `refusing to overwrite ${dataDir} without --force\n` +
        `  snapshot from ${snapshot.createdAt}: ${JSON.stringify(snapshot.counts)}`
      );
      process.exit(1);
    }
    console.log("restored:", JSON.stringify(restoreSnapshot(file, dataDir)));
  } else {
    const { file, bytes, counts } = writeSnapshot(dataDir);
    console.log(`wrote ${file} (${(bytes / 1024).toFixed(1)} KiB) — ${JSON.stringify(counts)}`);
  }
}
