/* Marathon Training Tracker — app logic.
 *
 * Users sign in (cookie session against /api/*); each user's data — uploaded
 * plans, schedules, and journals — is one state blob synced through
 * /api/data and cached per-user in localStorage for offline use.
 *
 * A "schedule" applies a plan to the calendar: mode "race" back-schedules so
 * the last plan day lands on the anchor date; mode "start" runs forward from
 * it. Journal entries are keyed by schedule id + plan-day index, with
 * updatedAt timestamps for merging and {deleted:true} tombstones so edits and
 * deletions converge across devices.
 */
"use strict";

const LAST_USER_KEY = "marathonTracker.lastUser";
const LEGACY_STATE_KEY = "marathonTracker.v1";
const LEGACY_SYNC_KEY = "marathonTracker.sync.v1";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const TYPE_LABELS = {
  rest: "Rest",
  easy: "Easy",
  workout: "Workout",
  long: "Long run",
  race: "Race day",
};

const BUILTIN_PLAN = {
  id: "builtin-swap12",
  name: "SWAP 12-Week Advanced Marathon Plan",
  builtin: true,
  htmlDetails: true,
  dayHeaders: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  weeks: PLAN_WEEKS,
};

let user = null;          // {id, email} when signed in
let offline = false;      // true when running from cache without a server
let authMode = "login";
let activeTab = "today";
let pendingPlanId = null; // preselect in the new-schedule form
let state = emptyState();

function emptyState() {
  return { plans: {}, schedules: {}, journal: {}, activeScheduleId: null, activeUpdatedAt: null };
}

/* ---------- persistence (per-user local cache) ---------- */

function cacheKey() {
  return `marathonTracker.u.${user.id}`;
}

function loadCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(cacheKey()));
    if (parsed && typeof parsed === "object") {
      return { ...emptyState(), ...parsed };
    }
  } catch { /* fall through */ }
  return null;
}

function saveState(triggerSync = true) {
  localStorage.setItem(cacheKey(), JSON.stringify(state));
  if (triggerSync) schedulePush();
}

function loadLastUser() {
  try {
    return JSON.parse(localStorage.getItem(LAST_USER_KEY));
  } catch {
    return null;
  }
}

/* Import data from the pre-accounts version of this app (single plan,
 * race date + journal in localStorage) as a schedule on first login. */
function migrateLegacyState() {
  let legacy = null;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_STATE_KEY));
  } catch { /* ignore */ }
  if (legacy && legacy.raceDate) {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    state.schedules[id] = {
      id,
      name: "My marathon (imported)",
      planId: BUILTIN_PLAN.id,
      mode: "race",
      anchorDate: legacy.raceDate,
      createdAt: now,
      updatedAt: now,
    };
    state.journal[id] = legacy.journal || {};
    if (!state.activeScheduleId) {
      state.activeScheduleId = id;
      state.activeUpdatedAt = now;
    }
    saveState();
  }
  localStorage.removeItem(LEGACY_STATE_KEY);
  localStorage.removeItem(LEGACY_SYNC_KEY);
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

const FMT_LONG = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});
const FMT_MED = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric",
});
const FMT_SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/* ---------- plans & schedules ---------- */

function livePlans() {
  return Object.values(state.plans).filter((p) => !p.deleted);
}

function liveSchedules() {
  return Object.values(state.schedules).filter((s) => !s.deleted)
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

function getPlan(planId) {
  if (planId === BUILTIN_PLAN.id) return BUILTIN_PLAN;
  const p = state.plans[planId];
  return p && !p.deleted ? p : null;
}

function activeSchedule() {
  const s = state.schedules[state.activeScheduleId];
  return s && !s.deleted && getPlan(s.planId) ? s : null;
}

/* Weeks align to the calendar: for 7-day plans, day 1 always lands on the
 * plan's first weekday (Monday for the built-in plan and Mon-first uploads).
 * Start mode snaps the start date forward to that weekday; race mode lays
 * out full aligned weeks with the race (the plan's last day) on its true
 * date — any final-week cells after race day are dropped.
 */
const WEEKDAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function weekStartDow(plan) {
  if (plan.weeks[0].days.length !== 7) return null; // only calendar-like plans align
  const key = String(plan.dayHeaders?.[0] || "").trim().toLowerCase().slice(0, 3);
  return WEEKDAY_INDEX[key] ?? 1; // default to Monday
}

function resolveSchedule(plan, mode, anchorISO) {
  const anchor = parseISODate(anchorISO);
  const alignDow = weekStartDow(plan);
  let start;
  let weekDayLists = plan.weeks.map((w) => w.days.slice());

  if (alignDow === null) {
    const len = weekDayLists.reduce((s, d) => s + d.length, 0);
    start = mode === "start" ? anchor : addDays(anchor, -(len - 1));
  } else if (mode === "start") {
    start = addDays(anchor, (alignDow - anchor.getDay() + 7) % 7);
  } else {
    const raceOffset = (anchor.getDay() - alignDow + 7) % 7; // race's position in its week
    start = addDays(anchor, -raceOffset - 7 * (weekDayLists.length - 1));
    if (raceOffset < 6) {
      const finalWeek = weekDayLists[weekDayLists.length - 1];
      weekDayLists[weekDayLists.length - 1] =
        [...finalWeek.slice(0, raceOffset), finalWeek[finalWeek.length - 1]];
    }
  }

  const days = [];
  const weeks = weekDayLists.map((list, wi) => {
    const firstIdx = days.length;
    for (const d of list) days.push({ week: wi + 1, ...d });
    return { week: wi + 1, firstIdx, lastIdx: days.length - 1, days: list };
  });
  return { days, weeks, len: days.length, start, end: addDays(start, days.length - 1) };
}

/* Resolved calendar info for a schedule. */
function schedInfo(sched) {
  const plan = getPlan(sched.planId);
  if (!plan) return null;
  const resolved = resolveSchedule(plan, sched.mode, sched.anchorDate);
  return {
    sched, plan, ...resolved,
    dpw: plan.weeks[0].days.length,
    weeksCount: resolved.weeks.length,
    todayIdx: Math.round((todayNoon() - resolved.start) / MS_PER_DAY),
    isRaceGoal: sched.mode === "race",
  };
}

function activeInfo() {
  const sched = activeSchedule();
  return sched ? schedInfo(sched) : null;
}

/* ---------- journal ---------- */

function entryFor(i) {
  const j = state.journal[state.activeScheduleId];
  const e = j && j[i];
  return e && !e.deleted ? e : null;
}

function setEntry(i, entry) {
  (state.journal[state.activeScheduleId] ||= {})[i] = entry;
}

function deleteEntry(i) {
  // tombstone instead of removal, so the deletion syncs to other devices
  setEntry(i, { deleted: true, updatedAt: new Date().toISOString() });
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

/* ---------- auth ---------- */

async function authRequest(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data };
}

const AUTH_ERRORS = {
  invalid_email: "That doesn't look like an email address.",
  password_too_short: "Passwords need at least 8 characters.",
  email_taken: "There's already an account with that email — try signing in.",
  invalid_credentials: "Wrong email or password.",
  too_many_attempts: "Too many attempts — wait a few minutes and try again.",
};

async function handleAuthSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const errEl = $("#auth-error");
  errEl.hidden = true;
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    const { ok, data } = await authRequest(
      authMode === "login" ? "/api/login" : "/api/register",
      { email: form.email.value, password: form.password.value }
    );
    if (!ok) {
      errEl.textContent = AUTH_ERRORS[data.error] || "Something went wrong — please try again.";
      errEl.hidden = false;
      return;
    }
    user = data.user;
    offline = false;
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
    state = loadCache() || emptyState();
    migrateLegacyState();
    // first-time users (no schedules) go straight to setup in Settings;
    // re-evaluate after sync in case another device already created one
    const autoSetup = !liveSchedules().length;
    activeTab = autoSetup ? "settings" : "today";
    render();
    await doSync();
    if (!liveSchedules().length) activeTab = "settings";
    else if (autoSetup && activeTab === "settings") activeTab = "today";
    render();
  } catch {
    errEl.textContent = "Can't reach the server — check your connection.";
    errEl.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

async function logout() {
  try { await authRequest("/api/logout"); } catch { /* best effort */ }
  user = null;
  localStorage.removeItem(LAST_USER_KEY);
  authMode = "login";
  render();
}

/* ---------- sync ---------- */

let syncStatus = { error: null, lastSync: null };
let syncInProgress = false;
let syncTimer = null;

function ts(v) {
  return v ? Date.parse(v) || 0 : 0;
}

function mergeById(localMap = {}, remoteMap = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])) {
    const a = localMap[k];
    const b = remoteMap[k];
    out[k] = ts(b && b.updatedAt) > ts(a && a.updatedAt) ? b : (a ?? b);
  }
  return out;
}

function mergeStates(local, remote) {
  const merged = {
    plans: mergeById(local.plans, remote.plans),
    schedules: mergeById(local.schedules, remote.schedules),
    journal: {},
    activeScheduleId: local.activeScheduleId,
    activeUpdatedAt: local.activeUpdatedAt,
  };
  const schedIds = new Set([
    ...Object.keys(local.journal || {}),
    ...Object.keys(remote.journal || {}),
  ]);
  for (const sid of schedIds) {
    merged.journal[sid] = mergeById((local.journal || {})[sid], (remote.journal || {})[sid]);
  }
  if (ts(remote.activeUpdatedAt) > ts(local.activeUpdatedAt)) {
    merged.activeScheduleId = remote.activeScheduleId;
    merged.activeUpdatedAt = remote.activeUpdatedAt;
  }
  return merged;
}

async function doSync() {
  if (!user || syncInProgress) return;
  syncInProgress = true;
  try {
    const getRes = await fetch("/api/data");
    if (getRes.status === 401) throw { loggedOut: true };
    if (!getRes.ok) throw new Error(`server error (${getRes.status})`);
    const remote = await getRes.json();
    if (remote && remote.state) {
      state = mergeStates(state, remote.state);
      saveState(false);
    }
    const putRes = await fetch("/api/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (putRes.status === 401) throw { loggedOut: true };
    if (!putRes.ok) throw new Error(`server error (${putRes.status})`);
    syncStatus = { error: null, lastSync: new Date().toISOString() };
    offline = false;
  } catch (e) {
    if (e && e.loggedOut) {
      user = null;
      syncInProgress = false;
      render();
      return;
    }
    syncStatus.error = e && e.message ? e.message : "network unreachable";
    offline = true;
  } finally {
    syncInProgress = false;
  }
}

function schedulePush() {
  if (!user) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await doSync();
    renderCountdownChip();
  }, 1500);
}

/* ---------- rendering ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function detailHTML(plan, text) {
  return plan.htmlDetails ? text : esc(text);
}

function render() {
  const signedIn = Boolean(user);
  $("#auth").hidden = signedIn;
  $("#app-main").hidden = !signedIn;
  $("#tabs").hidden = !signedIn;
  if (!signedIn) {
    renderAuth();
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
  if (activeTab === "schedule") renderScheduleTab();
  if (activeTab === "progress") renderProgress();
  if (activeTab === "plans") renderPlans();
  if (activeTab === "settings") renderSettings();
}

function renderAuth() {
  const isLogin = authMode === "login";
  $("#auth-title").textContent = isLogin ? "Sign in" : "Create your account";
  $("#auth-submit").textContent = isLogin ? "Sign in" : "Create account";
  $("#auth-switch-label").textContent = isLogin ? "New here?" : "Already have an account?";
  $("#auth-switch-link").textContent = isLogin ? "Create an account" : "Sign in";
  $("#auth-form").password.autocomplete = isLogin ? "current-password" : "new-password";
}

function renderCountdownChip() {
  const chip = $("#countdown-chip");
  const info = user && activeInfo();
  if (!info) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const remaining = info.len - 1 - info.todayIdx;
  if (info.isRaceGoal) {
    if (remaining > 0) chip.textContent = `🏁 ${remaining} day${remaining === 1 ? "" : "s"} to race day`;
    else if (remaining === 0) chip.textContent = "🏁 RACE DAY!";
    else chip.textContent = "🏁 Race complete";
  } else {
    if (info.todayIdx < 0) chip.textContent = `📅 starts ${FMT_SHORT.format(info.start)}`;
    else if (info.todayIdx >= info.len) chip.textContent = "✅ Plan complete";
    else chip.textContent = `📅 Day ${info.todayIdx + 1} of ${info.len}`;
  }
}

/* ----- plan importing (shared by the Plans tab and the schedule form) ----- */

function storeParsedPlan(parsed) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  state.plans[id] = { id, ...parsed, createdAt: now, updatedAt: now };
  saveState();
  return state.plans[id];
}

async function importPlanFile(file) {
  if (/\.pdf$/i.test(file.name) || file.type === "application/pdf") {
    const pages = await extractPdfPages(await file.arrayBuffer());
    const fallbackName = file.name.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim() || "Uploaded plan";
    return storeParsedPlan(PlanParser.parsePdfItems(pages, fallbackName));
  }
  return storeParsedPlan(PlanParser.parsePlanFile(file.name, await file.text()));
}

function plainPlanName(name) {
  return name.replace(/&[^;]+;/g, "");
}

/* ----- onboarding / new-schedule form ----- */

function planOptionsHTML(selectedId) {
  const options = [BUILTIN_PLAN, ...livePlans()];
  return options.map((p) => {
    const days = p.weeks.reduce((s, w) => s + w.days.length, 0);
    return `<option value="${p.id}" ${p.id === selectedId ? "selected" : ""}>
      ${p.name} (${p.weeks.length} wk / ${days} days)</option>`;
  }).join("");
}

function scheduleFormHTML() {
  return `
    <form class="schedule-form">
      <label>Training plan
        <select name="planId">${planOptionsHTML(pendingPlanId)}</select>
      </label>
      <div class="inline-controls form-upload-row">
        <label class="btn">Upload your own plan (PDF, Markdown, JSON)…<input
          type="file" class="form-plan-file" accept=".pdf,.md,.markdown,.json,.txt" hidden></label>
        <span class="form-upload-msg hint"></span>
      </div>
      <label>Schedule name <span class="hint-inline">(optional)</span>
        <input type="text" name="name" maxlength="60" placeholder="e.g. Chicago Marathon 2026">
      </label>
      <fieldset class="mode-fieldset">
        <legend>How should the plan land on the calendar?</legend>
        <label class="radio-row">
          <input type="radio" name="mode" value="race" checked>
          <span><strong>Work backward from my goal race</strong><br>
          <span class="hint">The last day of the plan lands on race day.</span></span>
        </label>
        <label class="radio-row">
          <input type="radio" name="mode" value="start">
          <span><strong>Start on a date</strong><br>
          <span class="hint">Day 1 is the date you pick (today by default).</span></span>
        </label>
      </fieldset>
      <label><span class="anchor-label">Race date</span>
        <input type="date" name="anchorDate" required>
      </label>
      <p class="hint anchor-preview"></p>
      <button type="submit" class="btn primary">Create schedule</button>
    </form>`;
}

function wireScheduleForm(container) {
  const form = $(".schedule-form", container);
  const updateLabels = () => {
    const isRace = form.mode.value === "race";
    $(".anchor-label", form).textContent = isRace ? "Race date" : "First training day";
    if (!form.anchorDate.value) {
      form.anchorDate.value = toISODate(todayNoon());
    }
    const plan = getPlan(form.planId.value);
    if (plan && form.anchorDate.value) {
      const r = resolveSchedule(plan, form.mode.value, form.anchorDate.value);
      const notes = [];
      if (!isRace && toISODate(r.start) !== form.anchorDate.value) {
        notes.push(`day 1 snaps to ${plan.dayHeaders?.[0] || "Monday"}`);
      }
      if (isRace && r.len % 7 !== 0 && weekStartDow(plan) !== null) {
        notes.push("final week ends on race day");
      }
      $(".anchor-preview", form).textContent =
        `${r.weeks.length} weeks: ${FMT_MED.format(r.start)} → ${FMT_MED.format(r.end)}` +
        (notes.length ? ` (${notes.join("; ")})` : "");
    }
  };
  form.addEventListener("input", updateLabels);
  updateLabels();

  $(".form-plan-file", form).addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const msgEl = $(".form-upload-msg", form);
    msgEl.classList.remove("sync-error");
    msgEl.textContent = "Reading…";
    try {
      const plan = await importPlanFile(file);
      pendingPlanId = plan.id;
      form.planId.innerHTML = planOptionsHTML(plan.id);
      msgEl.textContent = `Added “${plainPlanName(plan.name)}” — selected above.`;
      updateLabels();
    } catch (e) {
      msgEl.textContent = e.message || "Couldn't read that file.";
      msgEl.classList.add("sync-error");
    }
    ev.target.value = "";
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const plan = getPlan(form.planId.value);
    if (!plan || !form.anchorDate.value) return;
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    state.schedules[id] = {
      id,
      name: form.name.value.trim() || plan.name,
      planId: plan.id,
      mode: form.mode.value,
      anchorDate: form.anchorDate.value,
      createdAt: now,
      updatedAt: now,
    };
    state.activeScheduleId = id;
    state.activeUpdatedAt = now;
    pendingPlanId = null;
    saveState();
    activeTab = "today";
    render();
  });
}

function renderOnboarding(el, message) {
  el.innerHTML = `
    <div class="setup-card">
      <h2>${message || "Set up your training schedule"}</h2>
      <p>Pick a plan and anchor it to the calendar — either working backward from your
      goal race, or starting today. You can upload more plans in the
      <a href="#" class="goto-plans">Plans tab</a>.</p>
      ${scheduleFormHTML()}
    </div>`;
  wireScheduleForm(el);
  $(".goto-plans", el).addEventListener("click", (ev) => {
    ev.preventDefault();
    activeTab = "plans";
    render();
  });
}

/* ----- Today tab ----- */

function statusBadge(entry) {
  if (!entry || !entry.status) return "";
  const cls = { completed: "ok", modified: "mod", skipped: "skip" }[entry.status] || "";
  const label = { completed: "✓ Completed", modified: "~ Modified", skipped: "✗ Skipped" }[entry.status];
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function dayCard(info, i, { heading } = {}) {
  const day = info.days[i];
  const date = addDays(info.start, i);
  const entry = entryFor(i);
  const pace = paceFor(entry);
  const loggedBits = [];
  if (entry && entry.distance) loggedBits.push(`${entry.distance} mi`);
  if (entry && entry.duration) loggedBits.push(entry.duration);
  if (pace) loggedBits.push(pace);
  return `
    <article class="day-card type-${day.type}" data-day="${i}" tabindex="0" role="button"
             aria-label="Open day ${i + 1}">
      ${heading ? `<div class="card-heading">${esc(heading)}</div>` : ""}
      <div class="card-meta">
        <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
        <span class="card-date">${FMT_MED.format(date)} · Week ${day.week} · Day ${i + 1} of ${info.len}</span>
      </div>
      <h3 class="card-title">${day.title}</h3>
      <p class="card-detail">${detailHTML(info.plan, day.details[0])}</p>
      <div class="card-footer">
        ${statusBadge(entry)}
        ${loggedBits.length ? `<span class="logged-bits">${esc(loggedBits.join(" · "))}</span>` : ""}
        <span class="card-cta">${entry && entry.status ? "View / edit journal →" : "Open & journal →"}</span>
      </div>
    </article>`;
}

function renderToday() {
  const el = $("#tab-today");
  const info = activeInfo();
  if (!info) return renderOnboarding(el);

  const ti = info.todayIdx;
  if (ti < 0) {
    el.innerHTML = `
      <div class="notice">
        <h2>Training starts ${FMT_LONG.format(info.start)}</h2>
        <p>That's <strong>${-ti} day${ti === -1 ? "" : "s"}</strong> from now
        (${esc(info.sched.name)}). Here's Day 1 so you know what's coming:</p>
      </div>
      ${dayCard(info, 0, { heading: "First day of the plan" })}`;
  } else if (ti >= info.len) {
    el.innerHTML = `
      <div class="notice">
        <h2>🎉 Plan complete!</h2>
        <p><strong>${esc(info.sched.name)}</strong> ended ${FMT_LONG.format(info.end)}.
        Your journal is saved in the Schedule and Progress tabs, and you can set up the
        next block from Settings → New schedule.</p>
      </div>
      ${dayCard(info, info.len - 1, { heading: "Final day" })}`;
  } else {
    const isRaceDay = info.days[ti].type === "race";
    const parts = [dayCard(info, ti, { heading: isRaceDay ? "IT'S RACE DAY" : "Today's workout" })];
    if (ti + 1 < info.len) {
      parts.push(`<h2 class="section-label">Up next</h2>`, dayCard(info, ti + 1));
    }
    el.innerHTML = parts.join("");
  }
}

/* ----- Schedule tab ----- */

function renderScheduleTab() {
  const el = $("#tab-schedule");
  const info = activeInfo();
  if (!info) return renderOnboarding(el);

  const ti = info.todayIdx;
  const html = info.weeks.map((w) => {
    const wi = w.week - 1;
    const firstIdx = w.firstIdx;
    const rows = w.days.map((day, di) => {
      const i = firstIdx + di;
      const date = addDays(info.start, i);
      const entry = entryFor(i);
      const isToday = i === ti;
      const dot = entry && entry.status
        ? `<span class="dot dot-${entry.status}" title="${entry.status}"></span>`
        : `<span class="dot dot-none"></span>`;
      return `
        <li class="sched-row ${isToday ? "is-today" : ""} ${i < ti ? "is-past" : ""}"
            data-day="${i}" tabindex="0" role="button" aria-label="Open ${FMT_MED.format(date)}">
          ${dot}
          <span class="sched-date">${FMT_MED.format(date)}${isToday ? ' <span class="today-pill">Today</span>' : ""}</span>
          <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
          <span class="sched-title">${day.title}</span>
        </li>`;
    }).join("");
    const lastIdx = w.lastIdx;
    const range = `${FMT_SHORT.format(addDays(info.start, firstIdx))} – ${FMT_SHORT.format(addDays(info.start, lastIdx))}`;
    const isCurrent = ti >= firstIdx && ti <= lastIdx;
    return `
      <details class="week-block ${isCurrent ? "is-current" : ""}" ${isCurrent ? "open" : ""} id="week-${wi + 1}">
        <summary><strong>Week ${wi + 1}</strong> <span class="week-range">${range}</span>
          ${isCurrent ? '<span class="today-pill">Current</span>' : ""}</summary>
        <ul class="sched-list">${rows}</ul>
      </details>`;
  }).join("");

  el.innerHTML = `
    <p class="hint"><strong>${esc(info.sched.name)}</strong> — ${esc(info.plan.name)}.
    Click any day to see the full workout and write your journal entry.
    Legend: <span class="dot dot-completed"></span> completed ·
    <span class="dot dot-modified"></span> modified ·
    <span class="dot dot-skipped"></span> skipped</p>${html}`;
  const current = $(".week-block.is-current", el);
  if (current) current.scrollIntoView({ block: "nearest" });
}

/* ----- Progress tab ----- */

function weeklyTotals(info) {
  return info.weeks.map((w) => {
    let miles = 0, runs = 0, logged = 0;
    for (let i = w.firstIdx; i <= w.lastIdx; i++) {
      const e = entryFor(i);
      if (e && e.status) logged++;
      if (e && (e.status === "completed" || e.status === "modified") && e.distance) {
        miles += Number(e.distance);
        runs++;
      }
    }
    return {
      week: w.week, firstIdx: w.firstIdx, lastIdx: w.lastIdx,
      miles: Math.round(miles * 10) / 10, runs, logged, dayCount: w.days.length,
    };
  });
}

function renderProgress() {
  const el = $("#tab-progress");
  const info = activeInfo();
  if (!info) return renderOnboarding(el);

  const ti = info.todayIdx;
  const totals = weeklyTotals(info);
  const totalMiles = Math.round(totals.reduce((s, t) => s + t.miles, 0) * 10) / 10;
  const journal = state.journal[state.activeScheduleId] || {};
  const completed = Object.values(journal)
    .filter((e) => e && !e.deleted && (e.status === "completed" || e.status === "modified")).length;
  const daysElapsed = Math.max(0, Math.min(ti + 1, info.len));
  const pct = Math.round((daysElapsed / info.len) * 100);
  const remaining = Math.max(0, info.len - 1 - ti);

  const firstTile = info.isRaceGoal
    ? `<div class="stat-tile"><div class="stat-value">${remaining}</div><div class="stat-label">days to race</div></div>`
    : `<div class="stat-tile"><div class="stat-value">${remaining}</div><div class="stat-label">days left</div></div>`;

  const tableRows = totals.map((t) => {
    const range = `${FMT_SHORT.format(addDays(info.start, t.firstIdx))} – ${FMT_SHORT.format(addDays(info.start, t.lastIdx))}`;
    return `<tr><td>Week ${t.week}</td><td>${range}</td><td class="num">${t.miles || "—"}</td>
      <td class="num">${t.runs || "—"}</td><td class="num">${t.logged}/${t.dayCount}</td></tr>`;
  }).join("");

  el.innerHTML = `
    <div class="stat-row">
      ${firstTile}
      <div class="stat-tile"><div class="stat-value">${pct}%</div><div class="stat-label">through the plan</div></div>
      <div class="stat-tile"><div class="stat-value">${completed}</div><div class="stat-label">workouts completed</div></div>
      <div class="stat-tile"><div class="stat-value">${totalMiles}</div><div class="stat-label">miles logged</div></div>
    </div>
    <div class="chart-card viz-root">
      <h2 class="chart-title">Miles logged per week</h2>
      <p class="chart-sub">${esc(info.sched.name)} — distances from journal entries marked completed or modified.</p>
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

  drawMileageChart(info, totals);
}

function drawMileageChart(info, totals) {
  const container = $("#mileage-chart");
  const W = 720, H = 260;
  const margin = { top: 12, right: 12, bottom: 28, left: 36 };
  const iw = W - margin.left - margin.right;
  const ih = H - margin.top - margin.bottom;
  const maxMiles = Math.max(10, ...totals.map((t) => t.miles));
  const yMax = Math.ceil(maxMiles / 10) * 10;
  const ticks = [0, yMax / 2, yMax];
  const n = totals.length;
  const slot = iw / n;
  const barW = Math.min(34, slot * 0.6);
  const currentWeek = totals.find((t) => info.todayIdx >= t.firstIdx && info.todayIdx <= t.lastIdx);

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
    const bar = h > 0
      ? `<path class="bar" d="M${x},${margin.top + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${margin.top + ih} Z"/>`
      : "";
    const isCurrent = currentWeek && t.week === currentWeek.week;
    const label = n <= 20 || t.week === 1 || t.week === n || isCurrent || t.week % 5 === 0
      ? `<text x="${cx}" y="${H - 10}" class="axis-label ${isCurrent ? "axis-label-current" : ""}" text-anchor="middle">${t.week}</text>`
      : "";
    return `<g class="bar-group" data-week="${idx}">
      ${bar}
      <rect class="hit" x="${margin.left + slot * idx}" y="${margin.top}" width="${slot}" height="${ih}"/>
      ${label}
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
      const range = `${FMT_SHORT.format(addDays(info.start, t.firstIdx))} – ${FMT_SHORT.format(addDays(info.start, t.lastIdx))}`;
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

/* ----- Plans tab ----- */

/* pdf.js is vendored and loaded on demand — only when a PDF is uploaded. */
let pdfjsPromise = null;

async function extractPdfPages(arrayBuffer) {
  if (!pdfjsPromise) {
    pdfjsPromise = import("./vendor/pdf.min.mjs").then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = "js/vendor/pdf.worker.min.mjs";
      return mod;
    });
  }
  const pdfjs = await pdfjsPromise;
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    pages.push({
      items: tc.items
        .filter((i) => i.str && i.str.trim())
        .map((i) => ({ x: i.transform[4], y: i.transform[5], str: i.str })),
    });
  }
  return pages;
}

function renderPlans() {
  const el = $("#tab-plans");
  const userPlans = livePlans()
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const schedulesByPlan = {};
  for (const s of liveSchedules()) {
    (schedulesByPlan[s.planId] ||= []).push(s);
  }

  const planRow = (p) => {
    const days = p.weeks.reduce((s, w) => s + w.days.length, 0);
    const used = (schedulesByPlan[p.id] || []).length;
    return `
      <li class="plan-row" data-plan="${p.id}">
        <div class="plan-row-main">
          <strong>${p.name}</strong>
          <span class="hint">${p.weeks.length} weeks · ${days} days${p.builtin ? " · built-in" : ""}${used ? ` · used by ${used} schedule${used === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div class="plan-row-actions">
          <button class="btn use-plan" data-plan="${p.id}">Use this plan</button>
          ${p.builtin ? "" : `<button class="btn danger delete-plan" data-plan="${p.id}">Delete</button>`}
        </div>
      </li>`;
  };

  el.innerHTML = `
    <div class="settings-card">
      <h2>Upload a training plan</h2>
      <p>Upload a <strong>PDF</strong> (a grid-style plan — one row per week, one column per
      day), a <strong>markdown table</strong> in the same layout
      (<a href="plans/swap-12-week-marathon.md" target="_blank" rel="noopener">example</a>),
      or <strong>JSON</strong> (<a href="docs/plan-format.md" target="_blank" rel="noopener">format reference</a>).
      Day types (rest / easy / workout / long run / race) are detected automatically.</p>
      <div class="inline-controls">
        <label class="btn" for="plan-file">Choose file…</label>
        <input type="file" id="plan-file" accept=".pdf,.md,.markdown,.json,.txt" hidden>
        <span class="hint">or paste the plan text below</span>
      </div>
      <textarea id="plan-paste" rows="4" placeholder="| | Mon | Tue | … |&#10;| --- | --- | --- | … |&#10;| Week 1 | Rest | 5 mi easy | … |"></textarea>
      <div class="inline-controls">
        <button id="add-plan" class="btn primary">Add plan</button>
        <span id="plan-upload-msg" class="hint"></span>
      </div>
    </div>
    <div class="settings-card">
      <h2>Plan library</h2>
      <ul class="plan-list">
        ${planRow(BUILTIN_PLAN)}
        ${userPlans.map(planRow).join("")}
      </ul>
    </div>`;

  const msg = $("#plan-upload-msg");
  const announce = (plan) => {
    pendingPlanId = plan.id;
    render();
    const addedMsg = $("#plan-upload-msg");
    addedMsg.textContent = `Added “${plainPlanName(plan.name)}” — use “Use this plan” below to schedule it.`;
    addedMsg.classList.remove("sync-error");
  };
  const showUploadError = (e) => {
    const el = $("#plan-upload-msg");
    el.textContent = e.message || "Couldn't read that file.";
    el.classList.add("sync-error");
  };

  $("#plan-file").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (file) {
      msg.classList.remove("sync-error");
      msg.textContent = "Reading…";
      try {
        announce(await importPlanFile(file));
      } catch (e) {
        showUploadError(e);
      }
    }
    ev.target.value = "";
  });
  $("#add-plan").addEventListener("click", () => {
    const text = $("#plan-paste").value.trim();
    if (!text) {
      msg.textContent = "Choose a file or paste plan text first.";
      msg.classList.add("sync-error");
      return;
    }
    try {
      announce(storeParsedPlan(PlanParser.parsePlanFile("pasted plan", text)));
    } catch (e) {
      showUploadError(e);
    }
  });

  $$(".use-plan", el).forEach((b) => {
    b.addEventListener("click", () => {
      pendingPlanId = b.dataset.plan;
      activeTab = "settings";
      render();
      const details = $("#new-schedule-details");
      if (details) {
        details.open = true;
        details.scrollIntoView({ block: "start" });
      }
    });
  });
  $$(".delete-plan", el).forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.plan;
      const inUse = liveSchedules().filter((s) => s.planId === id);
      if (inUse.length) {
        alert(`This plan is used by: ${inUse.map((s) => s.name).join(", ")}. Delete those schedules first (Settings → My schedules).`);
        return;
      }
      if (!confirm("Delete this plan from your library?")) return;
      state.plans[id] = { id, deleted: true, updatedAt: new Date().toISOString() };
      saveState();
      render();
    });
  });
}

/* ----- Settings tab ----- */

function renderSettings() {
  const el = $("#tab-settings");
  const scheds = liveSchedules();
  const active = activeSchedule();

  const schedRow = (s) => {
    const info = schedInfo(s);
    const range = info
      ? `${FMT_SHORT.format(info.start)} – ${FMT_MED.format(info.end)}`
      : "plan missing";
    const planName = getPlan(s.planId)?.name || "(deleted plan)";
    const isActive = active && s.id === active.id;
    return `
      <li class="plan-row">
        <div class="plan-row-main">
          <strong>${esc(s.name)}</strong>
          ${isActive ? '<span class="today-pill">Active</span>' : ""}
          <span class="hint">${planName} · ${s.mode === "race" ? "race day" : "starts"} ${FMT_MED.format(parseISODate(s.anchorDate))} · ${range}</span>
        </div>
        <div class="plan-row-actions">
          ${isActive ? "" : `<button class="btn activate-sched" data-sched="${s.id}">Make active</button>`}
          <button class="btn danger delete-sched" data-sched="${s.id}">Delete</button>
        </div>
      </li>`;
  };

  const syncLine = syncStatus.error
    ? `<span class="sync-error">⚠ Offline (${esc(syncStatus.error)}) — changes are saved on this device and will sync when the server is reachable.</span>`
    : (syncStatus.lastSync ? `Synced ${new Date(syncStatus.lastSync).toLocaleString()}` : "Not synced yet this session");

  const firstRun = !scheds.length;
  const accountCard = `
    <div class="settings-card">
      <h2>Account</h2>
      <p>Signed in as <strong>${esc(user.email)}</strong>. Your plans, schedules, and
      journals are stored in your account — sign in anywhere to get them.</p>
      <p class="hint" id="account-sync-status">${syncLine}</p>
      <div class="inline-controls">
        <button id="sync-now" class="btn">Sync now</button>
        <button id="logout" class="btn">Log out</button>
      </div>
    </div>`;
  const newScheduleCard = `
    <div class="settings-card ${firstRun ? "is-first-run" : ""}">
      <details id="new-schedule-details" ${firstRun ? "open" : ""}>
        <summary><h2 class="summary-h2">${firstRun ? "Welcome! Set up your training schedule" : "New schedule"}</h2></summary>
        ${firstRun ? `<p>Three quick steps: pick the built-in marathon plan (or upload your
          own), choose how it lands on the calendar, and enter your race date — then the
          Today tab shows every day's workout.</p>` : ""}
        ${scheduleFormHTML()}
      </details>
    </div>`;

  el.innerHTML = `
    ${firstRun ? newScheduleCard + accountCard : accountCard + newScheduleCard}
    <div class="settings-card">
      <h2>My schedules</h2>
      ${scheds.length ? `<ul class="plan-list">${scheds.map(schedRow).join("")}</ul>`
        : '<p class="hint">No schedules yet — create one above.</p>'}
      <p class="hint">Each schedule keeps its own journal. Deleting a schedule deletes its journal too.</p>
    </div>
    <div class="settings-card">
      <h2>Backup</h2>
      <div class="inline-controls">
        <button id="export-json" class="btn">Export everything (JSON)</button>
        <label class="btn" for="import-json">Import…</label>
        <input type="file" id="import-json" accept="application/json" hidden>
      </div>
    </div>
    <div class="settings-card danger-zone">
      <h2>Reset</h2>
      <button id="reset-all" class="btn danger">Delete all my plans, schedules & journals</button>
    </div>`;

  wireScheduleForm(el);

  $("#sync-now").addEventListener("click", async () => {
    $("#account-sync-status").textContent = "Syncing…";
    await doSync();
    render();
  });
  $("#logout").addEventListener("click", logout);

  $$(".activate-sched", el).forEach((b) => {
    b.addEventListener("click", () => {
      state.activeScheduleId = b.dataset.sched;
      state.activeUpdatedAt = new Date().toISOString();
      saveState();
      render();
    });
  });
  $$(".delete-sched", el).forEach((b) => {
    b.addEventListener("click", () => {
      const s = state.schedules[b.dataset.sched];
      if (!confirm(`Delete “${s.name}” and its journal? This syncs to all your devices.`)) return;
      const now = new Date().toISOString();
      state.schedules[s.id] = { id: s.id, deleted: true, updatedAt: now };
      const journal = state.journal[s.id] || {};
      for (const k of Object.keys(journal)) {
        journal[k] = { deleted: true, updatedAt: now };
      }
      if (state.activeScheduleId === s.id) {
        state.activeScheduleId = liveSchedules()[0]?.id || null;
        state.activeUpdatedAt = now;
      }
      saveState();
      render();
    });
  });

  $("#export-json").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ state }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `marathon-training-backup-${toISODate(todayNoon())}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#import-json").addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = parsed.state || parsed;
      if (!imported || typeof imported !== "object" || (!imported.schedules && !imported.plans)) {
        throw new Error("bad file");
      }
      if (!confirm("Merge this backup into your current data?")) return;
      state = mergeStates(state, { ...emptyState(), ...imported });
      saveState();
      render();
      alert("Import complete!");
    } catch {
      alert("Sorry, that file doesn't look like a marathon-tracker backup.");
    }
  });

  $("#reset-all").addEventListener("click", () => {
    if (!confirm("Delete ALL your plans, schedules, and journal entries from your account and every synced device? This cannot be undone.")) return;
    const now = new Date().toISOString();
    // tombstone everything so the reset wins the merge on other devices
    for (const id of Object.keys(state.plans)) state.plans[id] = { id, deleted: true, updatedAt: now };
    for (const id of Object.keys(state.schedules)) state.schedules[id] = { id, deleted: true, updatedAt: now };
    for (const sid of Object.keys(state.journal)) {
      for (const k of Object.keys(state.journal[sid])) {
        state.journal[sid][k] = { deleted: true, updatedAt: now };
      }
    }
    state.activeScheduleId = null;
    state.activeUpdatedAt = now;
    saveState();
    activeTab = "today";
    render();
  });
}

/* ----- Day detail modal + journal form ----- */

function openDay(i) {
  const info = activeInfo();
  if (!info || !info.days[i]) return;
  const day = info.days[i];
  const date = addDays(info.start, i);
  const entry = entryFor(i) || {};
  const modal = $("#day-modal");

  const details = day.details.map((d) => `<p>${detailHTML(info.plan, d)}</p>`).join("");
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
      <span class="card-date">${FMT_LONG.format(date)} · Week ${day.week} · Day ${i + 1} of ${info.len}</span>
    </div>
    <h2 id="modal-title">${day.title}</h2>
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
    if (hasContent) setEntry(i, entryOut);
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
  $("#day-modal").close();
}

/* ---------- boot & wiring ---------- */

async function boot() {
  try {
    const res = await fetch("/api/me");
    if (res.ok) {
      user = (await res.json()).user;
      localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
    } else {
      user = null;
    }
  } catch {
    // server unreachable: fall back to the last signed-in user's cache
    const last = loadLastUser();
    if (last) {
      user = last;
      offline = true;
      syncStatus.error = "network unreachable";
    }
  }
  if (!user) {
    render();
    return;
  }
  state = loadCache() || emptyState();
  migrateLegacyState();
  const autoSetup = !liveSchedules().length;
  if (autoSetup) activeTab = "settings"; // straight to setup
  render();
  if (!offline) {
    await doSync();
    if (!liveSchedules().length) activeTab = "settings";
    else if (autoSetup && activeTab === "settings") activeTab = "today";
    render();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#auth-form").addEventListener("submit", handleAuthSubmit);
  $("#auth-switch-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    authMode = authMode === "login" ? "register" : "login";
    $("#auth-error").hidden = true;
    renderAuth();
  });

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

  $("#modal-close").addEventListener("click", closeModal);
  $("#day-modal").addEventListener("click", (ev) => {
    if (ev.target === ev.currentTarget) closeModal(); // backdrop click
  });

  // pull latest data whenever the tab regains focus
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && user && !$("#day-modal").open) {
      doSync().then(() => {
        if (!$("#day-modal").open) render();
      });
    }
  });

  boot();
});
