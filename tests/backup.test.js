/* Snapshot / restore correctness. Run: node tests/backup.test.js */
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const backup = require("../backup.js");

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log("PASS", name);
  } catch (e) {
    console.log("FAIL", name, "-", e.message);
    failed++;
  }
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
}

/* A data volume with two users, their training data, and a pending share. */
function seed(dir) {
  fs.mkdirSync(path.join(dir, "users"), { recursive: true });
  fs.mkdirSync(path.join(dir, "userdata"), { recursive: true });
  fs.mkdirSync(path.join(dir, "inbox"), { recursive: true });
  fs.writeFileSync(path.join(dir, "users.json"),
    JSON.stringify({ "a@x.com": "u1", "b@x.com": "u2" }));
  fs.writeFileSync(path.join(dir, "users/u1.json"),
    JSON.stringify({ id: "u1", email: "a@x.com", salt: "s", passwordHash: "h" }));
  fs.writeFileSync(path.join(dir, "users/u2.json"),
    JSON.stringify({ id: "u2", email: "b@x.com", salt: "s2", passwordHash: "h2" }));
  fs.writeFileSync(path.join(dir, "userdata/u1.json"),
    JSON.stringify({ state: { schedules: { s1: { name: "CIM" } }, journal: { s1: { 3: { distance: 12 } } } } }));
  fs.writeFileSync(path.join(dir, "inbox/u2.json"),
    JSON.stringify([{ id: "sh1", fromEmail: "a@x.com" }]));
  // sessions must NOT travel in a backup
  fs.writeFileSync(path.join(dir, "sessions.json"),
    JSON.stringify({ livetoken: { userId: "u1", expiresAt: Date.now() + 1e9 } }));
}

check("snapshot captures users, data and inboxes", () => {
  const dir = tmpDir();
  seed(dir);
  const snap = backup.createSnapshot(dir);
  assert.deepStrictEqual(snap.counts, { users: 2, userdata: 1, inbox: 1 });
  assert.strictEqual(snap.usersIndex["a@x.com"], "u1");
  assert.strictEqual(snap.userdata.u1.state.journal.s1[3].distance, 12);
  assert.strictEqual(snap.inbox.u2[0].id, "sh1");
});

check("snapshot excludes sessions (a leaked backup grants no login)", () => {
  const dir = tmpDir();
  seed(dir);
  const snap = backup.createSnapshot(dir);
  assert.ok(!("sessions" in snap), "snapshot must not contain sessions");
  assert.ok(!JSON.stringify(snap).includes("livetoken"), "session token leaked into snapshot");
});

check("write → restore into an empty volume reproduces every file", () => {
  const src = tmpDir();
  seed(src);
  const { file } = backup.writeSnapshot(src);
  const dest = tmpDir();
  const counts = backup.restoreSnapshot(file, dest);
  assert.deepStrictEqual(counts, { users: 2, userdata: 1, inbox: 1 });
  for (const rel of ["users.json", "users/u1.json", "users/u2.json",
                     "userdata/u1.json", "inbox/u2.json"]) {
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(dest, rel), "utf8")),
      JSON.parse(fs.readFileSync(path.join(src, rel), "utf8")),
      `${rel} differs after restore`);
  }
});

check("restore recovers data after a catastrophic wipe", () => {
  const dir = tmpDir();
  seed(dir);
  const { file } = backup.writeSnapshot(dir);
  const kept = fs.readFileSync(file); // pretend this copy lives off-box
  // volume loss: everything except the backup we pulled away
  fs.rmSync(path.join(dir, "users"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "userdata"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "inbox"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "users.json"), { force: true });
  const fresh = tmpDir();
  const restoreFrom = path.join(fresh, "offbox.json.gz");
  fs.writeFileSync(restoreFrom, kept);
  backup.restoreSnapshot(restoreFrom, fresh);
  const user = JSON.parse(fs.readFileSync(path.join(fresh, "users/u1.json"), "utf8"));
  const data = JSON.parse(fs.readFileSync(path.join(fresh, "userdata/u1.json"), "utf8"));
  assert.strictEqual(user.email, "a@x.com");
  assert.strictEqual(data.state.schedules.s1.name, "CIM");
});

check("rotation keeps only the newest N snapshots", () => {
  const dir = tmpDir();
  seed(dir);
  for (let i = 0; i < 5; i++) {
    // distinct filenames come from the timestamp, so nudge it forward
    const snap = backup.writeSnapshot(dir, { keep: 3 });
    fs.renameSync(snap.file, path.join(backup.backupsDir(dir),
      `backup-2026-01-0${i + 1}T00-00-00-000Z.json.gz`));
  }
  backup.pruneSnapshots(dir, 3);
  const list = backup.listSnapshots(dir);
  assert.strictEqual(list.length, 3, `expected 3 snapshots, got ${list.length}`);
  assert.ok(list[0].name.includes("2026-01-05"), "newest snapshot was pruned: " + list[0].name);
  assert.ok(!list.some((s) => s.name.includes("2026-01-01")), "oldest snapshot survived");
});

check("corrupt or foreign snapshots are rejected", () => {
  const dir = tmpDir();
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ version: 999, users: {} }));
  assert.throws(() => backup.readSnapshot(bad), /unsupported snapshot version/);
});

check("restore ignores path-traversal ids", () => {
  const dir = tmpDir();
  const file = path.join(dir, "evil.json");
  fs.writeFileSync(file, JSON.stringify({
    version: backup.SNAPSHOT_VERSION, createdAt: new Date().toISOString(),
    usersIndex: {}, users: { "../../escaped": { id: "x" } }, userdata: {}, inbox: {},
  }));
  const dest = tmpDir();
  backup.restoreSnapshot(file, dest);
  assert.ok(!fs.existsSync(path.join(dest, "..", "..", "escaped.json")), "escaped the data dir");
});

check("empty volume snapshots without throwing", () => {
  const snap = backup.createSnapshot(tmpDir());
  assert.deepStrictEqual(snap.counts, { users: 0, userdata: 0, inbox: 0 });
});

process.exit(failed ? 1 : 0);
