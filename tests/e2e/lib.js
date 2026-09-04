/* Shared helpers for the browser suites.
 *
 * Each suite boots its own server on its own port against a throwaway
 * DATA_DIR, so suites never share state and can be run in any order.
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const SWAP_MD = path.join(REPO, "plans", "swap-12-week-marathon.md");

function chromium() {
  // playwright-core is a dev-only dependency; install it with
  //   npm install --no-save playwright-core
  const mod = require(process.env.PLAYWRIGHT_PATH || "playwright-core");
  return mod.chromium;
}

function launch() {
  return chromium().launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
  });
}

async function waitForServer(base) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(base + "/api/me");
      if (res.status === 401 || res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start at " + base);
}

/** Start the app on a port with an empty data dir (or an existing one). */
async function startServer({ port, env = {}, dataDir } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), "e2e-data-"));
  let proc = spawn(process.execPath, [path.join(REPO, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, BACKUP_INTERVAL_HOURS: "0", ...env },
    stdio: "ignore",
  });
  const base = `http://localhost:${port}`;
  await waitForServer(base);
  return {
    base,
    dataDir: dir,
    /** Restart the process against the same volume, as a redeploy would. */
    async restart() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      proc = spawn(process.execPath, [path.join(REPO, "server.js")], {
        env: { ...process.env, PORT: String(port), DATA_DIR: dir, BACKUP_INTERVAL_HOURS: "0", ...env },
        stdio: "ignore",
      });
      await waitForServer(base);
    },
    stop() {
      proc.kill();
      if (!dataDir) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Collects page errors and genuinely-unexpected console errors. */
function trackErrors(page, tag, { allowStatus = [401, 404, 409] } = {}) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // the browser logs every non-2xx fetch; some are expected outcomes
    if (allowStatus.some((s) => m.text().includes(`status of ${s}`))) return;
    errors.push(`${tag} console: ${m.text()}`);
  });
  return errors;
}

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The next given weekday (0=Sun) at least `minDays` out.
 *
 * Careful: the result is minDays..minDays+6 days out, not minDays. A suite
 * that needs the date inside a bounded window (race week is 7 days) must pick
 * minDays so the whole 7-day spread still lands in it — otherwise it passes on
 * some weekdays and fails on others. Assert the window in the suite rather
 * than trusting the arithmetic. */
function upcoming(weekday, minDays = 32) {
  const d = new Date();
  d.setDate(d.getDate() + minDays);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  return d;
}

async function register(page, base, email, password = "password123") {
  await page.goto(base);
  await page.waitForSelector("#auth:not([hidden])");
  await page.click("#auth-switch-link");
  await page.fill('#auth-form input[name="email"]', email);
  await page.fill('#auth-form input[name="password"]', password);
  await page.click("#auth-submit");
  await page.waitForSelector(".schedule-form");
}

async function login(page, base, email, password = "password123") {
  await page.goto(base);
  await page.waitForSelector("#auth:not([hidden])");
  await page.fill('#auth-form input[name="email"]', email);
  await page.fill('#auth-form input[name="password"]', password);
  await page.click("#auth-submit");
}

/** Upload a plan inside the schedule form and create a schedule from it. */
async function createSchedule(page, { file = SWAP_MD, anchor, mode = "race", name } = {}) {
  await page.setInputFiles(".schedule-form .form-plan-file", file);
  await page.waitForFunction(
    () => document.querySelector(".form-upload-msg")?.textContent.includes("Added"),
    null, { timeout: 30000 });
  if (name) await page.fill('.schedule-form input[name="name"]', name);
  if (mode === "start") await page.check('.schedule-form input[value="start"]');
  if (anchor) await page.fill('.schedule-form input[name="anchorDate"]', iso(anchor));
  await page.click('.schedule-form button[type="submit"]');
  await page.waitForSelector("#tab-today .day-card, #tab-today .notice");
}

/** Open a schedule row, expanding its week first if collapsed. */
async function openDay(page, week, dayIndex) {
  await page.click('#tabs button[data-tab="schedule"]');
  await page.waitForSelector(".week-block");
  if ((await page.getAttribute(`#week-${week}`, "open")) === null) {
    await page.click(`#week-${week} summary`);
  }
  await page.click(`.sched-row[data-day="${dayIndex}"]`);
  await page.waitForSelector("#day-modal[open]");
}

/** Push local state to the server without waiting out the debounce. */
async function forceSync(page) {
  await page.click('#tabs button[data-tab="settings"]');
  await page.click("#sync-now");
  await page.waitForFunction(
    () => document.querySelector("#account-sync-status")?.textContent.includes("Synced"));
}

/** Tiny assertion helper that reports which suite step failed. */
function check(label, condition, detail = "") {
  // a missing condition silently fails every time — catch the mistake loudly
  if (arguments.length < 2) {
    throw new Error(`check("${label}") was called without a condition`);
  }
  if (!condition) throw new Error(`${label}${detail ? " — " + detail : ""}`);
  console.log("  ✓", label);
}

module.exports = {
  REPO, SWAP_MD, launch, startServer, trackErrors, iso, upcoming,
  register, login, createSchedule, openDay, forceSync, check,
};
