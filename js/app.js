/* Marathon Training Tracker — app logic.
 * State (race date + journal entries) lives in localStorage. Journal entries
 * are keyed by plan-day index (0–83), so they stay attached to the correct
 * plan day even if the race date is changed later.
 */
"use strict";

const STORAGE_KEY = "marathonTracker.v1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TYPE_LABELS = {
  rest: "Rest",
  easy: "Easy",
  workout: "Workout",
  long: "Long run",
  race: "Race day",
};

let state = loadState();
let activeTab = "today";
let openDayIndex = null;

/* ---------- persistence ---------- */

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return {
          raceDate: parsed.raceDate || null,
          raceDateUpdatedAt: parsed.raceDateUpdatedAt || null,
          journal: parsed.journal || {},
        };
      }
    }
  } catch (e) {
    console.warn("Could not load saved data:", e);
  }
  return { raceDate: null, raceDateUpdatedAt: null, journal: {} };
}

function saveState(triggerSync = true) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (triggerSync) schedulePush();
}

/* ---------- cross-device sync ----------
 * State syncs through the app's server (/api/sync) under a user-chosen sync
 * code. Merging is last-write-wins per journal entry via each entry's
 * updatedAt; deletions are kept as {deleted:true} tombstones so they
 * propagate. The race date carries its own raceDateUpdatedAt.
 */

const SYNC_CFG_KEY = "marathonTracker.sync.v1";
let syncCfg = loadSyncCfg();
let syncStatus = { error: null };
let syncInProgress = false;
let syncTimer = null;

function loadSyncCfg() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_CFG_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSyncCfg() {
  localStorage.setItem(SYNC_CFG_KEY, JSON.stringify(syncCfg));
}

function syncAvailable() {
  return location.protocol !== "file:";
}

function generateSyncCode() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no lookalikes
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((k) => chars.slice(k, k + 4).join("")).join("-");
}

async function syncFetch(method, body) {
  const res = await fetch("/api/sync", {
    method,
    headers: {
      "X-Sync-Code": syncCfg.code,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`sync server error (${res.status})`);
  return res.json();
}

function mergeStates(local, remote) {
  const ts = (v) => (v ? Date.parse(v) || 0 : 0);
  const merged = {
    raceDate: local.raceDate,
    raceDateUpdatedAt: local.raceDateUpdatedAt,
    journal: {},
  };
  if (
    (remote.raceDate || remote.raceDateUpdatedAt) &&
    (!local.raceDate || ts(remote.raceDateUpdatedAt) > ts(local.raceDateUpdatedAt))
  ) {
    merged.raceDate = remote.raceDate;
    merged.raceDateUpdatedAt = remote.raceDateUpdatedAt;
  }
  const keys = new Set([
    ...Object.keys(local.journal || {}),
    ...Object.keys(remote.journal || {}),
  ]);
  for (const k of keys) {
    const a = (local.journal || {})[k];
    const b = (remote.journal || {})[k];
    merged.journal[k] = ts(b && b.updatedAt) > ts(a && a.updatedAt) ? b : (a ?? b);
  }
  return merged;
}

async function doSync() {
  if (!syncCfg.enabled || syncInProgress || !syncAvailable()) return;
  syncInProgress = true;
  try {
    const remote = await syncFetch("GET");
    if (remote && remote.state) {
      state = mergeStates(state, remote.state);
      saveState(false);
    }
    // don't create a server record from an empty local state (e.g. a typo'd
    // code during restore)
    if (state.raceDate || Object.keys(state.journal).length) {
      await syncFetch("PUT", { state });
    }
    syncCfg.lastSync = new Date().toISOString();
    syncStatus.error = null;
    saveSyncCfg();
  } catch (e) {
    syncStatus.error = e.message;
  } finally {
    syncInProgress = false;
  }
}

function schedulePush() {
  if (!syncCfg.enabled || syncInProgress || !syncAvailable()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await doSync();
    renderCountdownChip();
    if (activeTab === "settings" && !$("#day-modal").open) render();
  }, 1500);
}

/* ---------- date helpers (noon-anchored to dodge DST edges) ---------- */

function parseISODate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 12);
}

function todayNoon() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
}

function startDate() {
  return addDays(parseISODate(state.raceDate), -RACE_DAY_INDEX);
}

function dateForIndex(i) {
  return addDays(startDate(), i);
}

function todayIndex() {
  return Math.round((todayNoon() - startDate()) / MS_PER_DAY);
}

const FMT_LONG = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});
const FMT_MED = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});
const FMT_SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* ---------- journal helpers ---------- */

function entryFor(i) {
  const e = state.journal[i];
  return e && !e.deleted ? e : null; // deleted = sync tombstone
}

function deleteEntry(i) {
  // tombstone instead of removal, so the deletion syncs to other devices
  state.journal[i] = { deleted: true, updatedAt: new Date().toISOString() };
}

function parseDuration(text) {
  // "1:32:05" or "45:30" or "45" (minutes) -> seconds, or null
  if (!text) return null;
  const parts = text.trim().split(":").map((p) => p.trim());
  if (parts.some((p) => p === "" || !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  let secs;
  if (nums.length === 3) secs = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else if (nums.length === 2) secs = nums[0] * 60 + nums[1];
  else if (nums.length === 1) secs = nums[0] * 60;
  else return null;
  return secs > 0 ? secs : null;
}

function formatPace(secondsPerMile) {
  const m = Math.floor(secondsPerMile / 60);
  const s = Math.round(secondsPerMile % 60);
  return `${m}:${String(s).padStart(2, "0")}/mi`;
}

function paceFor(entry) {
  if (!entry || !entry.distance) return null;
  const secs = parseDuration(entry.duration);
  if (!secs) return null;
  return formatPace(secs / entry.distance);
}

/* ---------- rendering ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function render() {
  const hasDate = Boolean(state.raceDate);
  $("#setup").hidden = hasDate;
  $("#app-main").hidden = !hasDate;
  $("#tabs").hidden = !hasDate;
  if (!hasDate) {
    renderCountdownChip();
    return;
  }
  renderCountdownChip();
  $$("#tabs button").forEach((b) => {
    const selected = b.dataset.tab === activeTab;
    b.classList.toggle("active", selected);
    b.setAttribute("aria-selected", selected ? "true" : "false");
  });
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${activeTab}`));
  if (activeTab === "today") renderToday();
  if (activeTab === "schedule") renderSchedule();
  if (activeTab === "progress") renderProgress();
  if (activeTab === "settings") renderSettings();
}

function renderCountdownChip() {
  const chip = $("#countdown-chip");
  if (!state.raceDate) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const days = RACE_DAY_INDEX - todayIndex();
  if (days > 0) chip.textContent = `🏁 ${days} day${days === 1 ? "" : "s"} to race day`;
  else if (days === 0) chip.textContent = "🏁 RACE DAY!";
  else chip.textContent = "🏁 Race complete";
}

/* ----- Today tab ----- */

function statusBadge(entry) {
  if (!entry || !entry.status) return "";
  const cls = { completed: "ok", modified: "mod", skipped: "skip" }[entry.status] || "";
  const label = { completed: "✓ Completed", modified: "~ Modified", skipped: "✗ Skipped" }[entry.status];
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function dayCard(i, { heading } = {}) {
  const day = PLAN_DAYS[i];
  const date = dateForIndex(i);
  const entry = entryFor(i);
  const pace = paceFor(entry);
  const loggedBits = [];
  if (entry && entry.distance) loggedBits.push(`${entry.distance} mi`);
  if (entry && entry.duration) loggedBits.push(entry.duration);
  if (pace) loggedBits.push(pace);
  return `
    <article class="day-card type-${day.type}" data-day="${i}" tabindex="0" role="button"
             aria-label="Open day ${i + 1}, ${esc(day.title)}">
      ${heading ? `<div class="card-heading">${esc(heading)}</div>` : ""}
      <div class="card-meta">
        <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
        <span class="card-date">${FMT_MED.format(date)} · Week ${day.week} · Day ${i + 1} of ${TOTAL_DAYS}</span>
      </div>
      <h3 class="card-title">${esc(day.title)}</h3>
      <p class="card-detail">${day.details[0]}</p>
      <div class="card-footer">
        ${statusBadge(entry)}
        ${loggedBits.length ? `<span class="logged-bits">${esc(loggedBits.join(" · "))}</span>` : ""}
        <span class="card-cta">${entry && entry.status ? "View / edit journal →" : "Open & journal →"}</span>
      </div>
    </article>`;
}

function renderToday() {
  const el = $("#tab-today");
  const ti = todayIndex();
  const race = parseISODate(state.raceDate);

  if (ti < 0) {
    el.innerHTML = `
      <div class="notice">
        <h2>Training starts ${FMT_LONG.format(startDate())}</h2>
        <p>That's <strong>${-ti} day${ti === -1 ? "" : "s"}</strong> from now. Your marathon is
        ${FMT_LONG.format(race)}. Here's Day 1 so you know what's coming:</p>
      </div>
      ${dayCard(0, { heading: "First day of the plan" })}`;
  } else if (ti > RACE_DAY_INDEX) {
    el.innerHTML = `
      <div class="notice">
        <h2>🎉 You did it!</h2>
        <p>Your marathon was ${FMT_LONG.format(race)}. Congratulations on the training block —
        your journal and progress are saved below in the Schedule and Progress tabs.</p>
      </div>
      ${dayCard(RACE_DAY_INDEX, { heading: "Race day" })}`;
  } else {
    const parts = [dayCard(ti, { heading: ti === RACE_DAY_INDEX ? "IT'S RACE DAY" : "Today's workout" })];
    if (ti + 1 <= RACE_DAY_INDEX) {
      parts.push(`<h2 class="section-label">Up next</h2>`, dayCard(ti + 1));
    }
    el.innerHTML = parts.join("");
  }
}

/* ----- Schedule tab ----- */

function renderSchedule() {
  const el = $("#tab-schedule");
  const ti = todayIndex();
  const html = PLAN_WEEKS.map((w) => {
    const firstIdx = (w.week - 1) * 7;
    const range = `${FMT_SHORT.format(dateForIndex(firstIdx))} – ${FMT_SHORT.format(dateForIndex(firstIdx + 6))}`;
    const isCurrent = ti >= firstIdx && ti < firstIdx + 7;
    const rows = w.days.map((day, di) => {
      const i = firstIdx + di;
      const date = dateForIndex(i);
      const entry = entryFor(i);
      const isToday = i === ti;
      const dot = entry && entry.status
        ? `<span class="dot dot-${entry.status}" title="${entry.status}"></span>`
        : `<span class="dot dot-none"></span>`;
      return `
        <li class="sched-row ${isToday ? "is-today" : ""} ${i < ti ? "is-past" : ""}"
            data-day="${i}" tabindex="0" role="button"
            aria-label="Open ${FMT_MED.format(date)}, ${esc(day.title)}">
          ${dot}
          <span class="sched-date">${FMT_MED.format(date)}${isToday ? ' <span class="today-pill">Today</span>' : ""}</span>
          <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
          <span class="sched-title">${esc(day.title)}</span>
        </li>`;
    }).join("");
    return `
      <details class="week-block ${isCurrent ? "is-current" : ""}" ${isCurrent ? "open" : ""} id="week-${w.week}">
        <summary><strong>Week ${w.week}</strong> <span class="week-range">${range}</span>
          ${isCurrent ? '<span class="today-pill">Current</span>' : ""}</summary>
        <ul class="sched-list">${rows}</ul>
      </details>`;
  }).join("");
  el.innerHTML = `<p class="hint">Click any day to see the full workout and write your journal entry.
    Legend: <span class="dot dot-completed"></span> completed · <span class="dot dot-modified"></span> modified ·
    <span class="dot dot-skipped"></span> skipped</p>${html}`;
  const current = $(".week-block.is-current", el);
  if (current) current.scrollIntoView({ block: "nearest" });
}

/* ----- Progress tab ----- */

function weeklyTotals() {
  return PLAN_WEEKS.map((w) => {
    const firstIdx = (w.week - 1) * 7;
    let miles = 0, runs = 0, logged = 0;
    for (let di = 0; di < 7; di++) {
      const e = entryFor(firstIdx + di);
      if (e && e.status) logged++;
      if (e && (e.status === "completed" || e.status === "modified") && e.distance) {
        miles += Number(e.distance);
        runs++;
      }
    }
    return { week: w.week, firstIdx, miles: Math.round(miles * 10) / 10, runs, logged };
  });
}

function renderProgress() {
  const el = $("#tab-progress");
  const ti = todayIndex();
  const totals = weeklyTotals();
  const totalMiles = Math.round(totals.reduce((s, t) => s + t.miles, 0) * 10) / 10;
  const totalLogged = Object.values(state.journal).filter((e) => e && e.status).length;
  const completed = Object.values(state.journal)
    .filter((e) => e && (e.status === "completed" || e.status === "modified")).length;
  const daysElapsed = Math.max(0, Math.min(ti + 1, TOTAL_DAYS));
  const pct = Math.round((daysElapsed / TOTAL_DAYS) * 100);
  const daysToRace = Math.max(0, RACE_DAY_INDEX - ti);

  const tiles = `
    <div class="stat-row">
      <div class="stat-tile"><div class="stat-value">${daysToRace}</div><div class="stat-label">days to race</div></div>
      <div class="stat-tile"><div class="stat-value">${pct}%</div><div class="stat-label">through the plan</div></div>
      <div class="stat-tile"><div class="stat-value">${completed}</div><div class="stat-label">workouts completed</div></div>
      <div class="stat-tile"><div class="stat-value">${totalMiles}</div><div class="stat-label">miles logged</div></div>
    </div>`;

  const tableRows = totals.map((t) => {
    const range = `${FMT_SHORT.format(dateForIndex(t.firstIdx))} – ${FMT_SHORT.format(dateForIndex(t.firstIdx + 6))}`;
    return `<tr><td>Week ${t.week}</td><td>${range}</td><td class="num">${t.miles || "—"}</td>
      <td class="num">${t.runs || "—"}</td><td class="num">${t.logged}/7</td></tr>`;
  }).join("");

  el.innerHTML = `
    ${tiles}
    <div class="chart-card viz-root">
      <h2 class="chart-title">Miles logged per week</h2>
      <p class="chart-sub">Distances from journal entries marked completed or modified.</p>
      <div id="mileage-chart"></div>
      <div id="chart-tooltip" class="chart-tooltip" hidden></div>
    </div>
    <div class="chart-card">
      <h2 class="chart-title">Week by week</h2>
      <div class="table-wrap"><table class="week-table">
        <thead><tr><th>Week</th><th>Dates</th><th class="num">Miles</th><th class="num">Runs</th><th class="num">Days logged</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </div>`;

  drawMileageChart(totals);
}

function drawMileageChart(totals) {
  const container = $("#mileage-chart");
  const W = 720, H = 260;
  const margin = { top: 12, right: 12, bottom: 28, left: 36 };
  const iw = W - margin.left - margin.right;
  const ih = H - margin.top - margin.bottom;
  const maxMiles = Math.max(10, ...totals.map((t) => t.miles));
  // nice ceiling: round up to a multiple of 10
  const yMax = Math.ceil(maxMiles / 10) * 10;
  const ticks = [0, yMax / 2, yMax];
  const n = totals.length;
  const slot = iw / n;
  const barW = Math.min(34, slot * 0.6);
  const currentWeek = Math.floor(todayIndex() / 7) + 1;

  const y = (v) => margin.top + ih - (v / yMax) * ih;
  const grid = ticks.map((t) => `
    <line x1="${margin.left}" x2="${W - margin.right}" y1="${y(t)}" y2="${y(t)}" class="gridline"/>
    <text x="${margin.left - 6}" y="${y(t) + 4}" class="axis-label" text-anchor="end">${t}</text>`).join("");

  const bars = totals.map((t, idx) => {
    const cx = margin.left + slot * idx + slot / 2;
    const x = cx - barW / 2;
    const top = y(t.miles);
    const h = margin.top + ih - top;
    const r = Math.min(4, h);
    // bar with rounded top corners only, anchored at the baseline
    const bar = h > 0
      ? `<path class="bar" d="M${x},${margin.top + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${margin.top + ih} Z"/>`
      : "";
    const isCurrent = t.week === currentWeek;
    return `<g class="bar-group" data-week="${idx}">
      ${bar}
      <rect class="hit" x="${margin.left + slot * idx}" y="${margin.top}" width="${slot}" height="${ih}"/>
      <text x="${cx}" y="${H - 10}" class="axis-label ${isCurrent ? "axis-label-current" : ""}" text-anchor="middle">${t.week}</text>
    </g>`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of miles logged per training week" style="width:100%;height:auto;display:block">
      ${grid}
      <line x1="${margin.left}" x2="${W - margin.right}" y1="${margin.top + ih}" y2="${margin.top + ih}" class="baseline"/>
      ${bars}
      <text x="${margin.left}" y="${H - 10}" class="axis-label" text-anchor="end">wk</text>
    </svg>`;

  const tooltip = $("#chart-tooltip");
  $$(".bar-group", container).forEach((g) => {
    g.addEventListener("mousemove", (ev) => {
      const t = totals[Number(g.dataset.week)];
      const range = `${FMT_SHORT.format(dateForIndex(t.firstIdx))} – ${FMT_SHORT.format(dateForIndex(t.firstIdx + 6))}`;
      tooltip.innerHTML = `<strong>Week ${t.week}</strong> · ${range}<br>${t.miles} mi · ${t.runs} run${t.runs === 1 ? "" : "s"} logged`;
      tooltip.hidden = false;
      const card = tooltip.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(ev.clientX - card.left + 12, card.width - 200))}px`;
      tooltip.style.top = `${Math.max(4, ev.clientY - card.top - 48)}px`;
      g.classList.add("hover");
    });
    g.addEventListener("mouseleave", () => {
      tooltip.hidden = true;
      g.classList.remove("hover");
    });
  });
}

/* ----- Settings tab ----- */

function renderSettings() {
  const el = $("#tab-settings");
  el.innerHTML = `
    <div class="settings-card">
      <h2>Race date</h2>
      <p>Your marathon: <strong>${FMT_LONG.format(parseISODate(state.raceDate))}</strong><br>
      Plan starts: <strong>${FMT_LONG.format(startDate())}</strong></p>
      <label for="race-date-edit">Change race date</label>
      <div class="inline-controls">
        <input type="date" id="race-date-edit" value="${state.raceDate}">
        <button id="save-race-date" class="btn primary">Update</button>
      </div>
      <p class="hint">Journal entries stay attached to their plan day (e.g. Week 5 Wednesday), so
      changing the date just shifts the calendar.</p>
    </div>
    <div class="settings-card">
      <h2>Cross-device sync</h2>
      ${syncCardHTML()}
    </div>
    <div class="settings-card">
      <h2>Backup</h2>
      <div class="inline-controls">
        <button id="export-json" class="btn">Export journal (JSON)</button>
        <label class="btn" for="import-json">Import journal…</label>
        <input type="file" id="import-json" accept="application/json" hidden>
      </div>
      <p class="hint">Data lives in this browser's local storage. Export before switching devices or clearing your browser.</p>
    </div>
    <div class="settings-card danger-zone">
      <h2>Reset</h2>
      <button id="reset-all" class="btn danger">Delete all data</button>
    </div>`;

  wireSyncCard();

  $("#save-race-date").addEventListener("click", () => {
    const v = $("#race-date-edit").value;
    if (!v) return;
    state.raceDate = v;
    state.raceDateUpdatedAt = new Date().toISOString();
    saveState();
    render();
  });
  $("#export-json").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `marathon-training-${state.raceDate}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#import-json").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed !== "object" || !parsed.raceDate) throw new Error("bad file");
      state = {
        raceDate: parsed.raceDate,
        raceDateUpdatedAt: new Date().toISOString(),
        journal: parsed.journal || {},
      };
      saveState();
      render();
      alert("Import complete!");
    } catch {
      alert("Sorry, that file doesn't look like a marathon-tracker export.");
    }
  });
  $("#reset-all").addEventListener("click", () => {
    if (confirm("Delete the race date and ALL journal entries on this device, and turn off sync? (Data already synced to the server is not deleted.) This cannot be undone.")) {
      syncCfg = {};
      saveSyncCfg();
      state = { raceDate: null, raceDateUpdatedAt: null, journal: {} };
      saveState(false);
      activeTab = "today";
      render();
    }
  });
}

function syncCardHTML() {
  if (!syncAvailable()) {
    return `<p class="hint">Sync needs the app's server. Open the app through
      <code>npm start</code> or your deployed URL (not as a local file) to use it.</p>`;
  }
  if (!syncCfg.enabled) {
    return `
      <p>Keep your race date and journal in sync across phones and computers.
      Create a sync code here, then enter the same code on your other devices.</p>
      <div class="inline-controls">
        <input type="text" id="sync-code-input" placeholder="your sync code" autocomplete="off">
        <button id="generate-code" class="btn">Generate code</button>
        <button id="enable-sync" class="btn primary">Turn on sync</button>
      </div>
      <p class="hint">Anyone with your sync code can read and change your training data —
      treat it like a password. Minimum 8 characters.</p>`;
  }
  const last = syncCfg.lastSync
    ? `Last synced ${new Date(syncCfg.lastSync).toLocaleString()}`
    : "Not synced yet";
  const status = syncStatus.error
    ? `<span class="sync-error">⚠ ${esc(syncStatus.error)} — changes are saved locally and will sync when the server is reachable.</span>`
    : esc(last);
  return `
    <p>Sync is <strong>on</strong>. Enter this code on another device
    (Settings → Cross-device sync, or “restore” on its start screen) to link it:</p>
    <div class="inline-controls">
      <code id="sync-code-display" class="sync-code" data-code="${esc(syncCfg.code)}">••••••••••••</code>
      <button id="show-code" class="btn">Show</button>
      <button id="copy-code" class="btn">Copy</button>
    </div>
    <p class="hint" id="sync-status">${status}</p>
    <div class="inline-controls">
      <button id="sync-now" class="btn">Sync now</button>
      <button id="disable-sync" class="btn danger">Turn off sync</button>
    </div>`;
}

function wireSyncCard() {
  if (!syncAvailable()) return;
  if (!syncCfg.enabled) {
    $("#generate-code").addEventListener("click", () => {
      $("#sync-code-input").value = generateSyncCode();
    });
    $("#enable-sync").addEventListener("click", async () => {
      const code = $("#sync-code-input").value.trim();
      if (code.length < 8) {
        alert("Sync codes must be at least 8 characters. Use Generate for a strong one.");
        return;
      }
      syncCfg = { code, enabled: true };
      saveSyncCfg();
      await doSync();
      render();
    });
    return;
  }
  $("#show-code").addEventListener("click", () => {
    const el = $("#sync-code-display");
    const hidden = el.textContent.startsWith("•");
    el.textContent = hidden ? el.dataset.code : "••••••••••••";
    $("#show-code").textContent = hidden ? "Hide" : "Show";
  });
  $("#copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(syncCfg.code);
      $("#copy-code").textContent = "Copied ✓";
      setTimeout(() => { const b = $("#copy-code"); if (b) b.textContent = "Copy"; }, 1500);
    } catch {
      alert(`Your sync code: ${syncCfg.code}`);
    }
  });
  $("#sync-now").addEventListener("click", async () => {
    $("#sync-status").textContent = "Syncing…";
    await doSync();
    render();
  });
  $("#disable-sync").addEventListener("click", () => {
    if (!confirm("Turn off sync on this device? Your local data stays; the server copy is kept for your other devices.")) return;
    syncCfg = {};
    saveSyncCfg();
    render();
  });
}

/* ----- Day detail modal + journal form ----- */

function openDay(i) {
  openDayIndex = i;
  const day = PLAN_DAYS[i];
  const date = dateForIndex(i);
  const entry = entryFor(i) || {};
  const modal = $("#day-modal");

  const details = day.details.map((d) => `<p>${d}</p>`).join("");
  const ratingButtons = [1, 2, 3, 4, 5].map((r) =>
    `<button type="button" class="star ${entry.rating >= r ? "on" : ""}" data-rating="${r}"
       aria-label="Rate ${r} of 5" aria-pressed="${entry.rating === r}">★</button>`).join("");
  const rpeOptions = ['<option value="">–</option>']
    .concat(Array.from({ length: 10 }, (_, k) =>
      `<option value="${k + 1}" ${Number(entry.rpe) === k + 1 ? "selected" : ""}>${k + 1}</option>`))
    .join("");

  $(".modal-body", modal).innerHTML = `
    <div class="card-meta">
      <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
      <span class="card-date">${FMT_LONG.format(date)} · Week ${day.week} · Day ${i + 1} of ${TOTAL_DAYS}</span>
    </div>
    <h2 id="modal-title">${esc(day.title)}</h2>
    <div class="workout-details">${details}</div>
    <hr>
    <form id="journal-form">
      <h3>Journal</h3>
      <div class="form-grid">
        <label>How did it go?
          <select name="status">
            <option value="">Not logged yet</option>
            <option value="completed" ${entry.status === "completed" ? "selected" : ""}>Completed as planned</option>
            <option value="modified" ${entry.status === "modified" ? "selected" : ""}>Completed with changes</option>
            <option value="skipped" ${entry.status === "skipped" ? "selected" : ""}>Skipped</option>
          </select>
        </label>
        <label>Distance (miles)
          <input type="number" name="distance" min="0" max="200" step="0.1"
                 value="${entry.distance ?? ""}" placeholder="e.g. 10.5">
        </label>
        <label>Total time
          <input type="text" name="duration" inputmode="numeric" pattern="[0-9:]*"
                 value="${esc(entry.duration ?? "")}" placeholder="hh:mm:ss or mm:ss">
        </label>
        <label>Effort (RPE 1–10)
          <select name="rpe">${rpeOptions}</select>
        </label>
      </div>
      <div class="pace-line" id="pace-line"></div>
      <div class="rating-line"><span>Felt like:</span><div class="stars" id="stars">${ratingButtons}</div></div>
      <label class="notes-label">Notes — splits, times, weather, fueling, how the legs felt…
        <textarea name="notes" rows="5" placeholder="e.g. 6 × 5min at 6:45 pace, 2min jog. Warm out. Felt strong on the last two reps.">${esc(entry.notes ?? "")}</textarea>
      </label>
      <div class="modal-actions">
        <button type="submit" class="btn primary">Save entry</button>
        ${entry.status || entry.notes || entry.distance ? '<button type="button" id="clear-entry" class="btn danger">Delete entry</button>' : ""}
        <span id="save-confirm" class="save-confirm" hidden>Saved ✓</span>
      </div>
    </form>`;

  let rating = entry.rating || 0;
  const updatePace = () => {
    const form = $("#journal-form");
    const dist = parseFloat(form.distance.value);
    const secs = parseDuration(form.duration.value);
    $("#pace-line").textContent =
      dist > 0 && secs ? `Average pace: ${formatPace(secs / dist)}` : "";
  };
  updatePace();
  $("#journal-form").addEventListener("input", updatePace);

  $$("#stars .star").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = Number(btn.dataset.rating);
      rating = rating === r ? 0 : r;
      $$("#stars .star").forEach((b) =>
        b.classList.toggle("on", Number(b.dataset.rating) <= rating));
    });
  });

  $("#journal-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const entryOut = {
      status: form.status.value || "",
      distance: form.distance.value ? Number(form.distance.value) : null,
      duration: form.duration.value.trim() || null,
      rpe: form.rpe.value ? Number(form.rpe.value) : null,
      rating: rating || null,
      notes: form.notes.value.trim() || null,
      updatedAt: new Date().toISOString(),
    };
    const hasContent = entryOut.status || entryOut.distance || entryOut.duration ||
      entryOut.rpe || entryOut.rating || entryOut.notes;
    if (hasContent) state.journal[i] = entryOut;
    else deleteEntry(i);
    saveState();
    const confirmEl = $("#save-confirm");
    confirmEl.hidden = false;
    setTimeout(() => { confirmEl.hidden = true; }, 1500);
    render();
  });

  const clearBtn = $("#clear-entry");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (!confirm("Delete this journal entry?")) return;
      deleteEntry(i);
      saveState();
      closeModal();
      render();
    });
  }

  modal.showModal();
}

function closeModal() {
  openDayIndex = null;
  $("#day-modal").close();
}

/* ---------- wiring ---------- */

document.addEventListener("DOMContentLoaded", () => {
  // Setup screen
  $("#setup-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = $("#race-date-input").value;
    if (!v) return;
    state.raceDate = v;
    state.raceDateUpdatedAt = new Date().toISOString();
    saveState();
    render();
  });
  const dateInput = $("#race-date-input");
  dateInput.min = toISODate(todayNoon());
  dateInput.addEventListener("input", () => {
    const hint = $("#sunday-hint");
    if (!dateInput.value) { hint.hidden = true; return; }
    const dow = parseISODate(dateInput.value).getDay();
    hint.hidden = dow === 0;
  });

  // Restore from a sync code on the setup screen
  if (!syncAvailable()) {
    $("#restore-wrap").hidden = true;
  } else {
    $("#restore-sync").addEventListener("click", async () => {
      const errEl = $("#restore-error");
      errEl.hidden = true;
      const code = $("#restore-code-input").value.trim();
      if (code.length < 8) {
        errEl.textContent = "Sync codes are at least 8 characters.";
        errEl.hidden = false;
        return;
      }
      syncCfg = { code, enabled: true };
      saveSyncCfg();
      await doSync();
      if (state.raceDate) {
        render();
      } else {
        syncCfg = {};
        saveSyncCfg();
        errEl.textContent = syncStatus.error
          ? `Couldn't reach the sync server (${syncStatus.error}).`
          : "No synced data found for that code — check it on your other device.";
        errEl.hidden = false;
      }
    });
  }

  // Pull latest data on load and whenever the tab regains focus
  if (syncCfg.enabled) {
    doSync().then(() => render());
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && syncCfg.enabled && !$("#day-modal").open) {
      doSync().then(() => {
        if (!$("#day-modal").open) render();
      });
    }
  });

  // Tabs
  $$("#tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      activeTab = b.dataset.tab;
      render();
    });
  });

  // Day cards / schedule rows (delegated)
  document.addEventListener("click", (ev) => {
    const target = ev.target.closest("[data-day]");
    if (target && !ev.target.closest("a")) openDay(Number(target.dataset.day));
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      const target = ev.target.closest?.("[data-day]");
      if (target) {
        ev.preventDefault();
        openDay(Number(target.dataset.day));
      }
    }
  });

  // Modal close
  $("#modal-close").addEventListener("click", closeModal);
  $("#day-modal").addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closeModal(); // backdrop click
  });

  render();
});
