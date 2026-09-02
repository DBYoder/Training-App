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

/* The SWAP plan used to ship as a built-in for every user. It no longer
 * does — new accounts start with an empty plan library — but accounts whose
 * schedules already reference the old built-in id get a real copy written
 * into their library so nothing breaks. */
const LEGACY_SWAP_ID = "builtin-swap12";

let user = null;          // {id, email} when signed in
let offline = false;      // true when running from cache without a server
let authMode = "login";
let activeTab = "today";
let pendingPlanId = null; // preselect in the new-schedule form
let builder = null;       // in-app plan builder state, or null
let sharePlanId = null;   // plan row with the share form open, or null
let sharesCache = [];     // last-fetched incoming shares
let state = emptyState();

function emptyState() {
  return {
    plans: {}, schedules: {}, journal: {},
    activeScheduleId: null, activeUpdatedAt: null,
    profile: null, // {raceDist, raceTime, goalTime, updatedAt} for pace zones
    checklists: {}, // race-week ticks, per schedule
  };
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
      planId: LEGACY_SWAP_ID,
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
  const p = state.plans[planId];
  return p && !p.deleted ? p : null;
}

/* Give pre-existing accounts a real copy of the formerly built-in SWAP plan
 * if any of their schedules still reference it. */
function materializeLegacySwapPlan() {
  const referenced = Object.values(state.schedules)
    .some((s) => !s.deleted && s.planId === LEGACY_SWAP_ID);
  if (!referenced || getPlan(LEGACY_SWAP_ID)) return;
  const now = new Date().toISOString();
  state.plans[LEGACY_SWAP_ID] = {
    id: LEGACY_SWAP_ID,
    name: "SWAP 12-Week Advanced Marathon Plan",
    dayHeaders: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    htmlDetails: true,
    weeks: PLAN_WEEKS,
    createdAt: now,
    updatedAt: now,
  };
  saveState(false);
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

/* Day swaps ("life happens — long run moves to Sunday"): sched.swaps maps a
 * calendar slot to the slot whose workout it displays. Journals stay keyed to
 * the calendar date; only the displayed workout moves. */
function applySwaps(resolved, sched) {
  const swaps = sched.swaps || {};
  if (!Object.keys(swaps).length) return resolved;
  const days = resolved.days.map((d, i) => {
    const src = swaps[i];
    return src !== undefined && resolved.days[src] !== undefined
      ? { ...resolved.days[src], week: d.week, swappedFrom: Number(src) }
      : d;
  });
  const weeks = resolved.weeks.map((w) => ({
    ...w,
    days: days.slice(w.firstIdx, w.lastIdx + 1),
  }));
  return { ...resolved, days, weeks };
}

function swapDays(schedId, i, j) {
  const sched = state.schedules[schedId];
  if (!sched || i === j) return;
  const swaps = { ...(sched.swaps || {}) };
  const srcI = swaps[i] ?? i;
  const srcJ = swaps[j] ?? j;
  swaps[i] = srcJ;
  swaps[j] = srcI;
  if (swaps[i] === i) delete swaps[i];
  if (swaps[j] === j) delete swaps[j];
  sched.swaps = swaps;
  sched.updatedAt = new Date().toISOString();
  saveState();
}

/* Resolved calendar info for a schedule. */
function schedInfo(sched) {
  const plan = getPlan(sched.planId);
  if (!plan) return null;
  const resolved = applySwaps(resolveSchedule(plan, sched.mode, sched.anchorDate), sched);
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

/* Duration parsing lives in paces.js so it can be unit-tested; phone keypads
 * have no colon, so "4530" and "45:30" must both mean 45 minutes 30 seconds. */
function parseDuration(text) {
  return PaceEngine.parseDuration(text);
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

/* ---------- target pace zones (Daniels VDOT — see js/paces.js) ---------- */

function currentVdot() {
  const p = state.profile;
  if (!p || !p.raceTime) return null;
  const meters = PaceEngine.RACE_DISTANCES[p.raceDist];
  const secs = parseDuration(p.raceTime);
  if (!meters || !secs) return null;
  return PaceEngine.vdotFromRace(meters, secs);
}

let zonesCacheKey = null;
let zonesCache = null;

function currentZones() {
  const vdot = currentVdot();
  if (!vdot) return null;
  const key = vdot.toFixed(3);
  if (zonesCacheKey !== key) {
    zonesCache = PaceEngine.trainingPaces(vdot);
    zonesCacheKey = key;
  }
  return zonesCache;
}

/* Pace chips for the zones a workout actually names ("M effort",
 * "1-hour effort", "10k", …). Zones come from the entered race result only —
 * never from the goal time. */
function paceChipsHTML(day) {
  const z = currentZones();
  if (!z) return "";
  const text = `${day.title} ${day.details.join(" ")}`.toLowerCase();
  const fp = PaceEngine.formatPaceSec;
  const chips = [];
  if (day.type === "race" || /\bm effort|marathon effort|at m\b/.test(text)) chips.push(["M", `${fp(z.M)}/mi`]);
  if (/1-hour effort|threshold|hard tempo/.test(text)) chips.push(["T", `${fp(z.T)}/mi`]);
  if (/10k/.test(text)) chips.push(["10k", `${fp(z.tenK)}/mi`]);
  if (/\b5k\b/.test(text)) chips.push(["5k", `${fp(z.fiveK)}/mi`]);
  if (/\b3k\b/.test(text)) chips.push(["3k", `${fp(z.threeK)}/mi`]);
  if (day.type === "easy" || day.type === "long" || /\beasy\b/.test(text)) {
    chips.push(["easy", `${fp(z.easySlow)}–${fp(z.easyFast)}/mi`]);
  }
  if (!chips.length) return "";
  return `<div class="pace-row">${chips.slice(0, 4)
    .map(([l, v]) => `<span class="pace-chip"><b>${l}</b> ${v}</span>`).join("")}</div>`;
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
  invalid_or_expired_token: "That link has expired or was already used — request a new one.",
};

async function handleAuthSubmit(ev) {
  ev.preventDefault();
  const form = ev.target;
  const errEl = $("#auth-error");
  errEl.hidden = true;
  const submit = $("#auth-submit");
  submit.disabled = true;
  try {
    if (authMode === "forgot") {
      await authRequest("/api/forgot", { email: form.email.value });
      // deliberately the same answer either way: never reveal who has an account
      setAuthMode("login",
        "If that address has an account, a reset link is on its way. It expires in an hour.");
      return;
    }
    if (authMode === "reset") {
      const { ok, data } = await authRequest("/api/reset",
        { token: pendingResetToken, password: form.password.value });
      if (!ok) {
        errEl.textContent = AUTH_ERRORS[data.error] || "That link is invalid or has expired.";
        errEl.hidden = false;
        return;
      }
      pendingResetToken = null;
      user = data.user;
      offline = false;
      localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
      state = loadCache() || emptyState();
  syncMeta = loadSyncMeta();
      await afterSignIn();
      return;
    }
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
  syncMeta = loadSyncMeta();
    await afterSignIn();
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
  syncMeta = { base: null, conflicts: [] };
  authMode = "login";
  render();
}

/* ---------- sync ---------- */

let syncStatus = { error: null, lastSync: null };

/* Per-device, never synced: the state as of the last successful sync (used to
 * tell a real conflict from a one-sided change) plus any conflicts found. */
let syncMeta = { base: null, conflicts: [] };
const MAX_CONFLICTS = 50;

function syncMetaKey() {
  return `${cacheKey()}.sync`;
}

function loadSyncMeta() {
  try {
    const parsed = JSON.parse(localStorage.getItem(syncMetaKey()));
    if (parsed && typeof parsed === "object") {
      return { base: parsed.base || null, conflicts: parsed.conflicts || [] };
    }
  } catch { /* fall through */ }
  return { base: null, conflicts: [] };
}

function saveSyncMeta() {
  try {
    localStorage.setItem(syncMetaKey(), JSON.stringify(syncMeta));
  } catch { /* quota: conflicts are advisory, never block a sync */ }
}

/* Only updatedAt is kept — enough to tell which side moved, and tiny. */
function snapshotBase(st) {
  const stamps = (map) => Object.fromEntries(
    Object.entries(map || {}).map(([k, v]) => [k, v && v.updatedAt]));
  return {
    plans: stamps(st.plans),
    schedules: stamps(st.schedules),
    checklists: stamps(st.checklists),
    journal: Object.fromEntries(
      Object.entries(st.journal || {}).map(([sid, j]) => [sid, stamps(j)])),
  };
}
let syncInProgress = false;
let syncTimer = null;
let pushPending = false;

function ts(v) {
  return v ? Date.parse(v) || 0 : 0;
}

/* Last-write-wins is fine when only one side moved. When BOTH sides changed
 * since the last successful sync, the loser is a real edit that would vanish
 * silently — so record it and let the user decide. Knowing what "changed"
 * means requires remembering the state at the last sync (the base). */
function mergeById(localMap = {}, remoteMap = {}, baseMap = null, onConflict = null) {
  const out = {};
  for (const k of new Set([...Object.keys(localMap), ...Object.keys(remoteMap)])) {
    const a = localMap[k];
    const b = remoteMap[k];
    const at = ts(a && a.updatedAt);
    const bt = ts(b && b.updatedAt);
    if (onConflict && baseMap && a && b && a.updatedAt !== b.updatedAt) {
      const base = baseMap[k];
      // a side that still matches the base simply didn't change
      if (a.updatedAt !== base && b.updatedAt !== base) {
        onConflict(k, bt > at ? b : a, bt > at ? a : b);
      }
    }
    out[k] = bt > at ? b : (a ?? b);
  }
  return out;
}

function mergeStates(local, remote, base = null, found = null) {
  const record = found
    ? (kind, extra) => (k, winner, loser) => found({ kind, id: k, winner, loser, ...extra })
    : () => null;
  // A missing entry in the base is meaningful — it means "didn't exist at the
  // last sync" — so only a null base (never synced) disables detection.
  const baseOf = (key) => (base ? base[key] || {} : null);
  const merged = {
    plans: mergeById(local.plans, remote.plans, baseOf("plans"), record("plan")),
    schedules: mergeById(local.schedules, remote.schedules, baseOf("schedules"), record("schedule")),
    journal: {},
    activeScheduleId: local.activeScheduleId,
    activeUpdatedAt: local.activeUpdatedAt,
  };
  const schedIds = new Set([
    ...Object.keys(local.journal || {}),
    ...Object.keys(remote.journal || {}),
  ]);
  for (const sid of schedIds) {
    merged.journal[sid] = mergeById(
      (local.journal || {})[sid], (remote.journal || {})[sid],
      base ? ((base.journal || {})[sid] || {}) : null,
      record("journal", { schedId: sid }));
  }
  if (ts(remote.activeUpdatedAt) > ts(local.activeUpdatedAt)) {
    merged.activeScheduleId = remote.activeScheduleId;
    merged.activeUpdatedAt = remote.activeUpdatedAt;
  }
  merged.checklists = mergeById(local.checklists, remote.checklists,
    baseOf("checklists"), record("checklist"));
  merged.profile = ts(remote.profile?.updatedAt) > ts(local.profile?.updatedAt)
    ? remote.profile
    : (local.profile ?? remote.profile ?? null);
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
      const found = [];
      state = mergeStates(state, remote.state, syncMeta.base, (c) => found.push(c));
      if (found.length) {
        const at = new Date().toISOString();
        syncMeta.conflicts = [
          ...found.map((c) => ({ ...c, detectedAt: at })),
          ...syncMeta.conflicts,
        ].slice(0, MAX_CONFLICTS);
      }
      saveState(false);
    }
    materializeLegacySwapPlan();
    const putRes = await fetch("/api/data", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    if (putRes.status === 401) throw { loggedOut: true };
    if (!putRes.ok) throw new Error(`server error (${putRes.status})`);
    syncStatus = { error: null, lastSync: new Date().toISOString() };
    // server and client now agree: this is the base the next merge compares to
    syncMeta.base = snapshotBase(state);
    saveSyncMeta();
    pushPending = false;
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
  pushPending = true;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    await doSync();
    renderCountdownChip();
  }, 1500);
}

/* If the tab is closed/hidden before the debounced push fires, flush the
 * state with a keepalive request so the write survives page teardown.
 * (Best effort: keepalive bodies are size-capped; the per-user local cache
 * still merges everything up on the next visit.) */
function flushPendingPush() {
  if (!user || !pushPending || syncInProgress) return;
  try {
    fetch("/api/data", {
      method: "PUT",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    }).catch(() => {});
    pushPending = false;
  } catch { /* over the keepalive size cap — next visit syncs it */ }
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

let pendingResetToken = null;
let verifyNotice = null;   // transient "email confirmed" message

/* Shared by sign-in, registration and a completed password reset. */
async function afterSignIn() {
  migrateLegacyState();
  materializeLegacySwapPlan();
  // first-time users (no schedules) go straight to setup in Settings;
  // re-evaluate after sync in case another device already created one
  const autoSetup = !liveSchedules().length;
  activeTab = autoSetup ? "settings" : "today";
  render();
  await doSync();
  if (!liveSchedules().length) activeTab = "settings";
  else if (autoSetup && activeTab === "settings") activeTab = "today";
  render();
}

const AUTH_COPY = {
  login:    { title: "Sign in",             submit: "Sign in" },
  register: { title: "Create your account", submit: "Create account" },
  forgot:   { title: "Reset your password", submit: "Email me a link" },
  reset:    { title: "Choose a new password", submit: "Set password" },
};

function renderAuth() {
  const copy = AUTH_COPY[authMode] || AUTH_COPY.login;
  const form = $("#auth-form");
  $("#auth-title").textContent = copy.title;
  $("#auth-submit").textContent = copy.submit;

  // forgot needs only an email; reset needs only a password
  form.email.closest("label").hidden = authMode === "reset";
  form.email.required = authMode !== "reset";
  form.password.closest("label").hidden = authMode === "forgot";
  form.password.required = authMode !== "forgot";
  form.password.autocomplete = authMode === "login" ? "current-password" : "new-password";
  form.password.placeholder = authMode === "reset"
    ? "new password, at least 8 characters" : "at least 8 characters";

  const isLogin = authMode === "login";
  $("#auth-switch-label").textContent = isLogin ? "New here?"
    : authMode === "register" ? "Already have an account?" : "Remembered it?";
  $("#auth-switch-link").textContent = isLogin ? "Create an account" : "Sign in";
  $("#auth-forgot-wrap").hidden = !isLogin;
}

function setAuthMode(mode, notice) {
  authMode = mode;
  $("#auth-error").hidden = true;
  const noticeEl = $("#auth-notice");
  noticeEl.hidden = !notice;
  if (notice) noticeEl.textContent = notice;
  renderAuth();
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
    if (remaining > 0) chip.textContent = `T-${remaining} day${remaining === 1 ? "" : "s"} to race day`;
    else if (remaining === 0) chip.textContent = "RACE DAY";
    else chip.textContent = "race complete";
  } else {
    if (info.todayIdx < 0) chip.textContent = `starts ${FMT_SHORT.format(info.start)}`;
    else if (info.todayIdx >= info.len) chip.textContent = "plan complete";
    else chip.textContent = `Day ${info.todayIdx + 1} of ${info.len}`;
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

/* ----- sharing & export ----- */

/* A shared plan is data authored by ANOTHER user's client — never trust its
 * HTML. Reduce every field to plain text, then re-run it through the same
 * parsing pipeline as uploads so the stored result is sanitized/classified
 * by our own code. */
function sanitizeSharedPlan(raw) {
  if (!raw || typeof raw !== "object") throw new Error("not a plan");
  const jsonShape = {
    name: htmlToPlainText(raw.name).slice(0, 120),
    dayHeaders: Array.isArray(raw.dayHeaders)
      ? raw.dayHeaders.map((h) => htmlToPlainText(h))
      : undefined,
    weeks: (Array.isArray(raw.weeks) ? raw.weeks : []).map((w) => ({
      days: (Array.isArray(w?.days) ? w.days : []).map((d) => ({
        type: d?.type,
        title: htmlToPlainText(d?.title),
        details: Array.isArray(d?.details) ? d.details.map(htmlToPlainText) : [],
      })),
    })),
  };
  return PlanParser.parseJsonPlan(JSON.stringify(jsonShape), "Shared plan");
}

function planSlug(plan) {
  return plainPlanName(plan.name).toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
}

function planToMarkdown(plan) {
  const cellEsc = (t) => t.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const headers = plan.dayHeaders.map((h) => htmlToPlainText(h));
  const lines = [`**${plainPlanName(plan.name)}**`, ""];
  lines.push(`|  | ${headers.join(" | ")} |`);
  lines.push(`| ${Array(headers.length + 1).fill("-----").join(" | ")} |`);
  plan.weeks.forEach((w, i) => {
    const cells = w.days.map((d) => cellEsc(dayCellText(d)));
    lines.push(`| Week ${i + 1} | ${cells.join(" | ")} |`);
  });
  return lines.join("\n") + "\n";
}

function downloadFile(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportPlanMarkdown(plan) {
  downloadFile(`${planSlug(plan)}.md`, planToMarkdown(plan), "text/markdown");
}

/* Print-formatted grid (light, paper-oriented). Opening it triggers the
 * browser's print dialog, where "Save as PDF" produces the file — and the
 * layout matches what our own PDF importer can read back. */
function printablePlanHTML(plan) {
  const name = plainPlanName(plan.name);
  const headers = plan.dayHeaders.map((h) => esc(htmlToPlainText(h)));
  const rows = plan.weeks.map((w, i) =>
    `<tr><th>Week ${i + 1}</th>${w.days.map((d) =>
      `<td><span class="t">${esc(TYPE_LABELS[d.type] || d.type)}</span>${esc(dayCellText(d))}</td>`
    ).join("")}</tr>`).join("");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(name)}</title><style>
    @page { size: letter landscape; margin: 1.2cm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 16px; background: #fff; }
    h1 { font-size: 16px; margin: 0 0 10px; }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; font-size: 7.5px; line-height: 1.35; }
    th, td { border: 1px solid #999; padding: 4px; vertical-align: top; text-align: left; }
    thead th { background: #eee; font-size: 9px; }
    tbody th { width: 44px; background: #f5f5f5; font-size: 8px; }
    .t { display: block; font-weight: bold; text-transform: uppercase; font-size: 6.5px; letter-spacing: 0.05em; color: #666; margin-bottom: 2px; }
    footer { margin-top: 8px; font-size: 7px; color: #888; }
  </style></head><body>
  <h1>${esc(name)}</h1>
  <table><thead><tr><th></th>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody></table>
  <footer>exported from marathon//trainer</footer>
  </body></html>`;
}

/* iCalendar export of a schedule: one all-day event per training day, ready
 * to import into Google/Apple Calendar. RFC 5545: escaped text, CRLF, lines
 * folded at 75 octets. */
function scheduleToICS(info) {
  const icsEsc = (t) => String(t)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const dt = (d) => toISODate(d).replace(/-/g, "");
  const fold = (line) => {
    const out = [];
    let rest = line;
    while (rest.length > 73) {
      out.push(rest.slice(0, 73));
      rest = " " + rest.slice(73);
    }
    out.push(rest);
    return out.join("\r\n");
  };
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//marathon-trainer//EN", "CALSCALE:GREGORIAN",
    fold(`X-WR-CALNAME:${icsEsc(info.sched.name)}`),
  ];
  info.days.forEach((day, i) => {
    const date = addDays(info.start, i);
    const summary = (day.type === "race" ? "RACE DAY — " : "") + plainPlanName(day.title);
    lines.push(
      "BEGIN:VEVENT",
      fold(`UID:${info.sched.id}-${i}@marathon-trainer`),
      `DTSTAMP:${dt(todayNoon())}T000000Z`,
      `DTSTART;VALUE=DATE:${dt(date)}`,
      `DTEND;VALUE=DATE:${dt(addDays(date, 1))}`,
      fold(`SUMMARY:${icsEsc(summary)}`),
      fold(`DESCRIPTION:${icsEsc(dayCellText(day))}`),
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function exportPlanPdf(plan) {
  const w = window.open("", "_blank");
  if (!w) {
    alert("Allow pop-ups for this site to export as PDF.");
    return;
  }
  w.document.write(printablePlanHTML(plan));
  w.document.close();
  setTimeout(() => {
    try {
      w.focus();
      w.print(); // "Save as PDF" in the dialog
    } catch { /* window closed; the view can still be printed manually */ }
  }, 300);
}

/* ----- onboarding / new-schedule form ----- */

function planOptionsHTML(selectedId) {
  const options = livePlans()
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  if (!options.length) {
    return '<option value="">no plans yet — upload or build one below</option>';
  }
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
        <label class="btn">Upload a plan (PDF, Markdown, JSON)…<input
          type="file" class="form-plan-file" accept=".pdf,.md,.markdown,.json,.txt" hidden></label>
        <button type="button" class="btn form-build-plan">build one from scratch</button>
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
    form.querySelector('button[type="submit"]').disabled = !plan;
    if (!plan) $(".anchor-preview", form).textContent = "";
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

  $(".form-build-plan", form).addEventListener("click", () => openBuilder(null));

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
      <p>Upload a training plan (or build one from scratch), then anchor it to the
      calendar — either working backward from your goal race, or starting today.
      Manage your plan library in the <a href="#" class="goto-plans">Plans tab</a>.</p>
      ${scheduleFormHTML()}
    </div>`;
  wireScheduleForm(el);
  $(".goto-plans", el).addEventListener("click", (ev) => {
    ev.preventDefault();
    activeTab = "plans";
    render();
  });
}

/* ----- race week (P2-9) -----
 * In the final week the useful thing is not another workout card: it's the
 * numbers you'll actually run on. Splits come from the runner's own pace
 * zones; fuelling targets are lifted from the plan's own race-day text
 * rather than invented here.
 */
const RACE_WEEK_DAYS = 7;
const MARATHON_MILES = 26.21875;

/* Pull the plan's own guidance ("75-90 g of carbs per hour") out of race day. */
function raceFuelling(day) {
  const text = htmlToPlainText(day.details.join(" "));
  const grab = (re) => {
    const m = text.match(re);
    return m ? m[1].replace(/\s*[-–]\s*/, "–") : null;
  };
  return {
    carbs: grab(/(\d+\s*(?:[-–]\s*\d+)?)\s*g\b[^.]{0,40}?carb/i),
    fluid: grab(/(\d+\s*(?:[-–]\s*\d+)?)\s*oz\b[^.]{0,40}?(?:fluid|water|drink)/i),
  };
}

/* Goal-pace splits. Prefers the runner's stated goal when it is consistent
 * with current fitness, otherwise the VDOT-predicted time — never a number
 * they have no business chasing on race day. */
function racePlan() {
  const vdot = currentVdot();
  if (!vdot) return null;
  const predicted = PaceEngine.equivalentRaceTime(vdot, 42195);
  const goalSecs = state.profile && state.profile.goalTime
    ? parseDuration(state.profile.goalTime) : null;
  const useGoal = goalSecs && goalSecs >= predicted * 0.98;
  const target = useGoal ? goalSecs : predicted;
  const perMile = target / MARATHON_MILES;
  const marks = [
    ["5K", 3.10686], ["10K", 6.21371], ["10 mi", 10],
    ["Half", 13.10937], ["20 mi", 20], ["Finish", MARATHON_MILES],
  ];
  return {
    target,
    perMile,
    basedOn: useGoal ? "your goal time" : "your current fitness",
    goalWasOptimistic: Boolean(goalSecs && !useGoal),
    splits: marks.map(([label, miles]) => ({
      label,
      at: PaceEngine.formatClock(Math.round(perMile * miles)),
    })),
  };
}

const RACE_CHECKLIST = [
  ["pace", "Know your opening pace — go out no faster than target"],
  ["fuel", "Carry the gels/drink the plan calls for, and practise nothing new"],
  ["kit", "Lay out kit, shoes and bib the night before"],
  ["watch", "Charge the watch; set it to the fields you actually use"],
  ["logistics", "Confirm start time, travel and bag drop"],
  ["sleep", "Bank sleep earlier in the week — race-eve sleep matters least"],
];

function checklistFor(schedId) {
  const rec = state.checklists && state.checklists[schedId];
  return (rec && rec.items) || {};
}

function toggleChecklist(schedId, itemId, on) {
  state.checklists ||= {};
  const items = { ...checklistFor(schedId), [itemId]: on };
  state.checklists[schedId] = { items, updatedAt: new Date().toISOString() };
  saveState();
}

function raceWeekHTML(info) {
  if (!info.isRaceGoal) return "";
  const raceIdx = info.len - 1;
  const daysOut = raceIdx - info.todayIdx;
  if (daysOut < 0 || daysOut > RACE_WEEK_DAYS) return "";

  const fuel = raceFuelling(info.days[raceIdx]);
  const plan = racePlan();
  const ticked = checklistFor(info.sched.id);
  const when = daysOut === 0 ? "Today" : `In ${daysOut} day${daysOut === 1 ? "" : "s"}`;

  const splitRows = plan ? `
    <p class="hint">Target ${PaceEngine.formatClock(Math.round(plan.target))} —
      ${PaceEngine.formatPaceSec(plan.perMile)}/mi, based on ${plan.basedOn}.${
        plan.goalWasOptimistic
          ? " Your goal is ahead of what your last race predicts, so these splits use current fitness."
          : ""}</p>
    <div class="split-grid">
      ${plan.splits.map((sp) => `
        <div class="split"><b>${sp.label}</b><span>${sp.at}</span></div>`).join("")}
    </div>`
    : `<p class="hint">Add a recent race result in Settings → pace zones to see goal splits here.</p>`;

  const fuelLine = (fuel.carbs || fuel.fluid)
    ? `<p class="hint">Your plan says: ${[
        fuel.carbs && `<strong>${esc(fuel.carbs)} g carbs/hour</strong>`,
        fuel.fluid && `<strong>${esc(fuel.fluid)} oz fluid/hour</strong>`,
      ].filter(Boolean).join(" · ")}${
        plan ? ` — roughly ${Math.round(plan.target / 3600 * parseInt(fuel.carbs || "0", 10))}–${
          Math.round(plan.target / 3600 * (parseInt((fuel.carbs || "0").split("–")[1] || fuel.carbs || "0", 10)))
        } g over ${PaceEngine.formatClock(Math.round(plan.target))}.` : ""}</p>`
    : "";

  return `
    <details class="race-week" id="race-week" open>
      <summary><span class="race-week-title">🏁 Race week — ${when}</span></summary>
      ${splitRows}
      ${fuelLine}
      <ul class="checklist">
        ${RACE_CHECKLIST.map(([id, label]) => `
          <li>
            <label>
              <input type="checkbox" class="race-check" data-item="${id}" ${ticked[id] ? "checked" : ""}>
              <span>${esc(label)}</span>
            </label>
          </li>`).join("")}
      </ul>
    </details>`;
}

function wireRaceWeek(el, info) {
  $$(".race-check", el).forEach((box) => {
    box.addEventListener("change", () => {
      toggleChecklist(info.sched.id, box.dataset.item, box.checked);
      box.closest("li").classList.toggle("done", box.checked);
    });
    box.closest("li").classList.toggle("done", box.checked);
  });
}

/* ----- sync conflicts ----- */

function conflictSummary(entry) {
  if (!entry) return "nothing";
  if (entry.deleted) return "deleted";
  const bits = [];
  if (entry.status) bits.push(entry.status);
  if (entry.distance) bits.push(`${entry.distance} mi`);
  if (entry.duration) bits.push(entry.duration);
  if (entry.rpe) bits.push(`RPE ${entry.rpe}`);
  if (entry.notes) bits.push(`“${entry.notes.slice(0, 60)}${entry.notes.length > 60 ? "…" : ""}”`);
  return bits.join(" · ") || "an empty entry";
}

/* What the conflict is about, in the user's terms. */
function conflictLabel(c) {
  if (c.kind === "journal") {
    const sched = state.schedules[c.schedId];
    const info = sched && !sched.deleted ? schedInfo(sched) : null;
    const idx = Number(c.id);
    if (info && Number.isFinite(idx) && info.days[idx]) {
      return `${FMT_MED.format(addDays(info.start, idx))} — ${plainPlanName(info.days[idx].title)}`;
    }
    return `Day ${Number.isFinite(idx) ? idx + 1 : "?"}`;
  }
  if (c.kind === "plan") return `Plan: ${plainPlanName(c.winner?.name || "")}`;
  return `Schedule: ${esc(c.winner?.name || "")}`;
}

function conflictsHTML() {
  const list = syncMeta.conflicts;
  if (!list.length) return "";
  return `
    <details class="conflict-card" id="conflict-card">
      <summary>
        <span class="conflict-count">⚠ ${list.length} edit${list.length === 1 ? "" : "s"} replaced by another device</span>
        <span class="hint">review</span>
      </summary>
      <p class="hint">When two devices change the same thing while offline, the most recent
      edit wins. These are the ones that were replaced — restore any you'd rather keep.</p>
      <ul class="plan-list">
        ${list.map((c, i) => `
          <li class="plan-row">
            <div class="plan-row-main">
              <strong>${esc(conflictLabel(c))}</strong>
              <span class="hint">kept: ${esc(conflictSummary(c.winner))}</span>
              <span class="hint conflict-loser">replaced: ${esc(conflictSummary(c.loser))}</span>
            </div>
            <div class="plan-row-actions">
              <button class="btn restore-conflict" data-idx="${i}">Restore replaced</button>
              <button class="btn dismiss-conflict" data-idx="${i}">Dismiss</button>
            </div>
          </li>`).join("")}
      </ul>
      <button id="dismiss-all-conflicts" class="btn">Dismiss all</button>
    </details>`;
}

function wireConflicts(el) {
  if (!syncMeta.conflicts.length) return;
  const drop = (idx) => {
    syncMeta.conflicts.splice(idx, 1);
    saveSyncMeta();
    render();
  };
  $$(".dismiss-conflict", el).forEach((b) =>
    b.addEventListener("click", () => drop(Number(b.dataset.idx))));
  $("#dismiss-all-conflicts", el).addEventListener("click", () => {
    syncMeta.conflicts = [];
    saveSyncMeta();
    render();
  });
  $$(".restore-conflict", el).forEach((b) => {
    b.addEventListener("click", () => {
      const c = syncMeta.conflicts[Number(b.dataset.idx)];
      if (!c || !c.loser) return;
      // a fresh timestamp so the restored version wins the next merge
      const restored = { ...c.loser, updatedAt: new Date().toISOString() };
      if (c.kind === "journal") (state.journal[c.schedId] ||= {})[c.id] = restored;
      else if (c.kind === "plan") state.plans[c.id] = restored;
      else state.schedules[c.id] = restored;
      saveState();
      drop(Number(b.dataset.idx));
    });
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
  const second = secondOf(entry);
  return `
    <article class="day-card type-${day.type}" data-day="${i}" tabindex="0" role="button"
             aria-label="Open day ${i + 1}">
      ${heading ? `<div class="card-heading">${esc(heading)}</div>` : ""}
      <div class="card-meta">
        <span class="type-tag type-tag-${day.type}">${TYPE_LABELS[day.type]}</span>
        <span class="card-date">${FMT_MED.format(date)} · Week ${day.week} · Day ${i + 1} of ${info.len}</span>
        ${day.swappedFrom !== undefined
          ? `<span class="type-tag swap-tag" title="workout moved from ${FMT_MED.format(addDays(info.start, day.swappedFrom))}">⇄ swapped</span>` : ""}
      </div>
      <h3 class="card-title">${day.title}</h3>
      <p class="card-detail">${detailHTML(info.plan, day.details[0])}</p>
      ${paceChipsHTML(day)}
      <div class="card-footer">
        ${statusBadge(entry)}
        ${loggedBits.length ? `<span class="logged-bits">${esc(loggedBits.join(" · "))}</span>` : ""}
        ${second ? `<span class="second-chip" title="second session">+ ${esc(secondSummary(second))}</span>` : ""}
        ${!(entry && entry.status) && day.type !== "rest" && i <= info.todayIdx
          ? `<button class="btn quick-log" data-quicklog="${i}">✓ done</button>` : ""}
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
      ${conflictsHTML()}
      <div class="notice">
        <h2>Training starts ${FMT_LONG.format(info.start)}</h2>
        <p>That's <strong>${-ti} day${ti === -1 ? "" : "s"}</strong> from now
        (${esc(info.sched.name)}). Here's Day 1 so you know what's coming:</p>
      </div>
      ${dayCard(info, 0, { heading: "First day of the plan" })}`;
    wireConflicts(el);
  } else if (ti >= info.len) {
    el.innerHTML = `
      ${conflictsHTML()}
      <div class="notice">
        <h2>Plan complete</h2>
        <p><strong>${esc(info.sched.name)}</strong> ended ${FMT_LONG.format(info.end)}.
        Your journal is saved in the Schedule and Progress tabs, and you can set up the
        next block from Settings → New schedule.</p>
      </div>
      ${dayCard(info, info.len - 1, { heading: "Final day" })}`;
    wireConflicts(el);
  } else {
    const isRaceDay = info.days[ti].type === "race";
    const parts = [conflictsHTML(), raceWeekHTML(info),
      dayCard(info, ti, { heading: isRaceDay ? "IT'S RACE DAY" : "Today's workout" })];
    if (!state.profile) {
      parts.push(`<p class="hint pace-tip">tip: add a recent race result in
        <a href="#" class="goto-pace-settings">Settings → pace zones</a> to see your
        target paces on every workout.</p>`);
    }
    // back-fill nudge: yesterday went unlogged (rest days don't count)
    if (ti > 0 && !entryFor(ti - 1) && info.days[ti - 1].type !== "rest") {
      parts.push(`<h2 class="section-label">yesterday — not logged</h2>`, dayCard(info, ti - 1));
    }
    if (ti + 1 < info.len) {
      parts.push(`<h2 class="section-label">Up next</h2>`, dayCard(info, ti + 1));
    }
    el.innerHTML = parts.join("");
    wireConflicts(el);
    wireRaceWeek(el, info);
    const tip = $(".goto-pace-settings", el);
    if (tip) {
      tip.addEventListener("click", (ev) => {
        ev.preventDefault();
        activeTab = "settings";
        render();
        $("#pace-card")?.scrollIntoView({ block: "start" });
      });
    }
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

/* Planned mileage from the day's own text ("8–12 mi easy…"). First mileage
 * mention only, so interval days that list just a warm-up undercount — the
 * band is labeled as "listed" mileage, an honest floor rather than a guess. */
function plannedMilesForDay(day) {
  if (day.type === "rest") return null;
  if (day.type === "race") return { lo: 26.2, hi: 26.2 };
  const text = htmlToPlainText(day.details.join(" "));
  const m = text.match(/(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?\s*mi(?:les?\b|\b)/i);
  if (!m) return null;
  const lo = parseFloat(m[1]);
  const hi = m[2] ? parseFloat(m[2]) : lo;
  return hi >= lo ? { lo, hi } : { lo: hi, hi: lo };
}

function weeklyTotals(info) {
  return info.weeks.map((w) => {
    let miles = 0, runs = 0, logged = 0, plannedLo = 0, plannedHi = 0, trainingDays = 0;
    let xtrain = 0, xtrainSeconds = 0;
    for (let i = w.firstIdx; i <= w.lastIdx; i++) {
      const day = info.days[i];
      if (day.type !== "rest") trainingDays++; // rest days don't count against you
      const planned = plannedMilesForDay(day);
      if (planned) {
        plannedLo += planned.lo;
        plannedHi += planned.hi;
      }
      const e = entryFor(i);
      if (e && e.status) logged++;
      if (e && (e.status === "completed" || e.status === "modified") && e.distance) {
        miles += Number(e.distance);
        runs++;
      }
      // a logged second session counts on its own, even if the main run was
      // skipped; only running kinds add to weekly mileage
      const second = secondOf(e);
      if (second) {
        if (secondIsRun(second)) {
          if (second.distance) miles += Number(second.distance);
          runs++;
        } else {
          // cross-training and strength are measured in time, never miles
          xtrain++;
          xtrainSeconds += parseDuration(second.duration) || 0;
        }
      }
    }
    return {
      week: w.week, firstIdx: w.firstIdx, lastIdx: w.lastIdx,
      miles: Math.round(miles * 10) / 10, runs, xtrain, xtrainSeconds,
      logged: Math.min(logged, trainingDays), dayCount: trainingDays,
      plannedLo: Math.round(plannedLo), plannedHi: Math.round(plannedHi),
    };
  });
}

/* ----- adherence & streaks (P2-10) -----
 * "Am I actually doing the plan?" is the question people ask at week 8, and
 * the journal already holds the answer. Rest days are honoured, not counted
 * against you, and today is never held against you until it's over.
 */
function adherenceStats(info) {
  const lastElapsed = Math.min(info.todayIdx, info.len - 1);
  let due = 0, done = 0;
  for (let i = 0; i <= lastElapsed; i++) {
    if (info.days[i].type === "rest") continue;
    due++;
    const e = entryFor(i);
    if (e && (e.status === "completed" || e.status === "modified")) done++;
  }

  // walk back from the most recent finished day; rest days carry the streak
  let streak = 0;
  let start = lastElapsed;
  const todayEntry = start >= 0 ? entryFor(start) : null;
  if (start === info.todayIdx && info.days[start] &&
      info.days[start].type !== "rest" && !todayEntry) {
    start--; // today isn't over — don't break a streak on it
  }
  for (let i = start; i >= 0; i--) {
    const day = info.days[i];
    if (day.type === "rest") { streak++; continue; }
    const e = entryFor(i);
    if (e && (e.status === "completed" || e.status === "modified")) streak++;
    else break;
  }

  let best = 0, run = 0;
  for (let i = 0; i <= lastElapsed; i++) {
    const day = info.days[i];
    const e = entryFor(i);
    if (day.type === "rest" || (e && (e.status === "completed" || e.status === "modified"))) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }

  return {
    due, done, streak, best,
    pct: due ? Math.round((done / due) * 100) : null,
    elapsed: lastElapsed >= 0,
  };
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
  const adherence = adherenceStats(info);

  const firstTile = info.isRaceGoal
    ? `<div class="stat-tile"><div class="stat-value">${remaining}</div><div class="stat-label">days to race</div></div>`
    : `<div class="stat-tile"><div class="stat-value">${remaining}</div><div class="stat-label">days left</div></div>`;

  const tableRows = totals.map((t) => {
    const range = `${FMT_SHORT.format(addDays(info.start, t.firstIdx))} – ${FMT_SHORT.format(addDays(info.start, t.lastIdx))}`;
    const planned = t.plannedHi
      ? (t.plannedLo === t.plannedHi ? `${t.plannedHi}` : `${t.plannedLo}–${t.plannedHi}`)
      : "—";
    // cross-training is reported as time; fall back to a session count only
    // when sessions were logged without a duration
    const xtrainCell = t.xtrainSeconds
      ? formatHoursMin(t.xtrainSeconds)
      : (t.xtrain ? `${t.xtrain}×` : "—");
    const xtrainTitle = t.xtrain
      ? ` title="${t.xtrain} session${t.xtrain === 1 ? "" : "s"}"` : "";
    return `<tr><td>Week ${t.week}</td><td>${range}</td><td class="num">${planned}</td>
      <td class="num">${t.miles || "—"}</td>
      <td class="num">${t.runs || "—"}</td><td class="num"${xtrainTitle}>${xtrainCell}</td>
      <td class="num">${t.logged}/${t.dayCount}</td></tr>`;
  }).join("");
  const totalXtrain = totals.reduce((s, t) => s + t.xtrain, 0);
  const totalXtrainSeconds = totals.reduce((s, t) => s + t.xtrainSeconds, 0);

  el.innerHTML = `
    <div class="stat-row">
      ${firstTile}
      <div class="stat-tile"><div class="stat-value">${pct}%</div><div class="stat-label">through the plan</div></div>
      <div class="stat-tile"><div class="stat-value">${completed}</div><div class="stat-label">workouts completed</div></div>
      <div class="stat-tile"><div class="stat-value">${totalMiles}</div><div class="stat-label">miles logged</div></div>
      ${adherence.elapsed && adherence.pct !== null ? `
        <div class="stat-tile" title="${adherence.done} of ${adherence.due} scheduled runs so far (rest days excluded)">
          <div class="stat-value">${adherence.pct}%</div>
          <div class="stat-label">plan adherence</div>
        </div>
        <div class="stat-tile" title="Consecutive days on plan; rest days count, today doesn't count against you${adherence.best > adherence.streak ? ` · best so far ${adherence.best}` : ""}">
          <div class="stat-value">${adherence.streak}</div>
          <div class="stat-label">day streak${adherence.best > adherence.streak ? ` · best ${adherence.best}` : ""}</div>
        </div>` : ""}
      ${totalXtrain ? `<div class="stat-tile"><div class="stat-value">${
        totalXtrainSeconds ? formatHoursMin(totalXtrainSeconds) : totalXtrain
      }</div><div class="stat-label">${
        totalXtrainSeconds ? "x-train / strength (h:mm)" : "x-train sessions"
      }</div></div>` : ""}
    </div>
    <div class="chart-card viz-root">
      <h2 class="chart-title">Miles logged per week</h2>
      <p class="chart-sub">${esc(info.sched.name)} — bars are logged miles; the outlined band is the
      plan's listed mileage range (interval days that list only a warm-up undercount slightly).</p>
      <div id="mileage-chart"></div>
      <div id="chart-tooltip" class="chart-tooltip" hidden></div>
    </div>
    <div class="chart-card viz-root" id="pace-trend-card" hidden>
      <h2 class="chart-title">Average pace per week</h2>
      <p class="chart-sub">All logged runs with a time and distance — higher is faster.</p>
      <div id="pace-chart"></div>
      <div id="pace-tooltip" class="chart-tooltip" hidden></div>
    </div>
    <div class="chart-card">
      <h2 class="chart-title">Week by week</h2>
      <div class="table-wrap"><table class="week-table">
        <thead><tr><th>Week</th><th>Dates</th><th class="num">Planned mi</th><th class="num">Miles</th><th class="num">Runs</th><th class="num">X-train</th><th class="num">Days logged</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table></div>
    </div>`;

  drawMileageChart(info, totals);
  drawPaceTrend(info, totals);
}

/* The charts draw in viewBox units stretched to the container's width. On a
 * phone a 720-unit box is squeezed to ~44%, which would render 11px labels at
 * under 5px — so narrow screens get a viewBox close to their real width and
 * everything is drawn at near 1:1. */
function isNarrowViewport() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function drawMileageChart(info, totals) {
  const container = $("#mileage-chart");
  const narrow = isNarrowViewport();
  // match the viewBox to the real container width so labels render 1:1
  const W = narrow ? Math.max(280, Math.round(container.clientWidth) || 320) : 720;
  const H = narrow ? 220 : 260;
  const margin = narrow
    ? { top: 10, right: 8, bottom: 26, left: 30 }
    : { top: 12, right: 12, bottom: 28, left: 36 };
  const iw = W - margin.left - margin.right;
  const ih = H - margin.top - margin.bottom;
  const maxMiles = Math.max(10, ...totals.map((t) => Math.max(t.miles, t.plannedHi || 0)));
  const yMax = Math.ceil(maxMiles / 10) * 10;
  const ticks = [0, yMax / 2, yMax];
  const n = totals.length;
  const slot = iw / n;
  const barW = Math.min(narrow ? 18 : 34, slot * 0.6);
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
    // planned-range band behind the bar (context layer, muted outline)
    const bandW = Math.min(barW + 12, slot * 0.85);
    const band = t.plannedHi > 0
      ? `<rect class="planned-band" x="${cx - bandW / 2}" y="${y(t.plannedHi)}"
           width="${bandW}" height="${Math.max(2, y(t.plannedLo) - y(t.plannedHi))}"/>`
      : "";
    const bar = h > 0
      ? `<path class="bar" d="M${x},${margin.top + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${margin.top + ih} Z"/>`
      : "";
    const isCurrent = currentWeek && t.week === currentWeek.week;
    const label = n <= 20 || t.week === 1 || t.week === n || isCurrent || t.week % 5 === 0
      ? `<text x="${cx}" y="${H - 10}" class="axis-label ${isCurrent ? "axis-label-current" : ""}" text-anchor="middle">${t.week}</text>`
      : "";
    return `<g class="bar-group" data-week="${idx}">
      ${band}
      ${bar}
      <rect class="hit" x="${margin.left + slot * idx}" y="${margin.top}" width="${slot}" height="${ih}"/>
      ${label}
    </g>`;
  }).join("");

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" class="chart-svg"
         aria-label="Bar chart of miles logged per training week">
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
      const plannedBit = t.plannedHi
        ? ` · planned ${t.plannedLo === t.plannedHi ? t.plannedHi : `${t.plannedLo}–${t.plannedHi}`} mi`
        : "";
      tooltip.innerHTML = `<strong>Week ${t.week}</strong> · ${range}<br>${t.miles} mi · ${t.runs} run${t.runs === 1 ? "" : "s"} logged${plannedBit}`;
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

/* Average pace per week from journal entries with time + distance. */
function drawPaceTrend(info, totals) {
  const points = totals.map((t) => {
    let secs = 0, miles = 0;
    for (let i = t.firstIdx; i <= t.lastIdx; i++) {
      const e = entryFor(i);
      if (!e || !(e.status === "completed" || e.status === "modified")) continue;
      const s = parseDuration(e.duration);
      if (s && e.distance > 0) {
        secs += s;
        miles += Number(e.distance);
      }
    }
    return { week: t.week, pace: miles > 0 ? secs / miles : null, miles: Math.round(miles * 10) / 10 };
  });
  const withData = points.filter((p) => p.pace !== null);
  const card = $("#pace-trend-card");
  if (withData.length < 1) return; // card stays hidden
  card.hidden = false;

  const narrow = isNarrowViewport();
  const paceContainer = $("#pace-chart");
  const W = narrow ? Math.max(280, Math.round(paceContainer.clientWidth) || 320) : 720;
  const H = narrow ? 180 : 200;
  const margin = narrow
    ? { top: 12, right: 8, bottom: 26, left: 40 }
    : { top: 14, right: 12, bottom: 28, left: 48 };
  const iw = W - margin.left - margin.right;
  const ih = H - margin.top - margin.bottom;
  const n = points.length;
  const slot = iw / n;
  const minPace = Math.min(...withData.map((p) => p.pace));
  const maxPace = Math.max(...withData.map((p) => p.pace));
  const pad = Math.max(15, (maxPace - minPace) * 0.2);
  const yTop = minPace - pad;   // fastest at the top
  const yBot = maxPace + pad;
  const y = (p) => margin.top + ((p - yTop) / (yBot - yTop)) * ih;
  const x = (idx) => margin.left + slot * idx + slot / 2;
  const fp = PaceEngine.formatPaceSec;

  const ticks = [yTop + pad * 0.2, (yTop + yBot) / 2, yBot - pad * 0.2];
  const grid = ticks.map((t) => `
    <line x1="${margin.left}" x2="${W - margin.right}" y1="${y(t)}" y2="${y(t)}" class="gridline"/>
    <text x="${margin.left - 6}" y="${y(t) + 4}" class="axis-label" text-anchor="end">${fp(t)}</text>`).join("");

  // line segments between consecutive weeks that both have data
  let path = "";
  for (let idx = 1; idx < n; idx++) {
    if (points[idx].pace !== null && points[idx - 1].pace !== null) {
      path += `M${x(idx - 1)},${y(points[idx - 1].pace)} L${x(idx)},${y(points[idx].pace)} `;
    }
  }
  const dots = points.map((p, idx) => p.pace === null ? "" : `
    <g class="pace-point" data-week="${idx}">
      <circle class="dot-mark" cx="${x(idx)}" cy="${y(p.pace)}" r="4"/>
      <rect class="hit" x="${margin.left + slot * idx}" y="${margin.top}" width="${slot}" height="${ih}"/>
    </g>`).join("");
  const labels = points.map((p, idx) =>
    `<text x="${x(idx)}" y="${H - 10}" class="axis-label" text-anchor="middle">${p.week}</text>`).join("");

  paceContainer.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" class="chart-svg"
         aria-label="Line chart of average pace per training week">
      ${grid}
      <path class="pace-line" d="${path.trim()}"/>
      ${dots}
      ${labels}
      <text x="${margin.left}" y="${H - 10}" class="axis-label" text-anchor="end">wk</text>
    </svg>`;

  const tooltip = $("#pace-tooltip");
  $$(".pace-point", card).forEach((g) => {
    g.addEventListener("mousemove", (ev) => {
      const p = points[Number(g.dataset.week)];
      tooltip.innerHTML = `<strong>Week ${p.week}</strong><br>${fp(p.pace)}/mi avg · ${p.miles} mi`;
      tooltip.hidden = false;
      const rect = tooltip.parentElement.getBoundingClientRect();
      tooltip.style.left = `${Math.max(8, Math.min(ev.clientX - rect.left + 12, rect.width - 180))}px`;
      tooltip.style.top = `${Math.max(4, ev.clientY - rect.top - 48)}px`;
    });
    g.addEventListener("mouseleave", () => { tooltip.hidden = true; });
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
  if (builder) return renderBuilder(el);
  el.oninput = null; // clear any builder input handler
  const userPlans = livePlans()
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  const schedulesByPlan = {};
  for (const s of liveSchedules()) {
    (schedulesByPlan[s.planId] ||= []).push(s);
  }

  const planRow = (p) => {
    const days = p.weeks.reduce((s, w) => s + w.days.length, 0);
    const used = (schedulesByPlan[p.id] || []).length;
    const shareForm = sharePlanId === p.id ? `
      <li class="share-form-row">
        <div class="inline-controls">
          <input type="email" class="share-email" placeholder="teammate@email.com" autocomplete="off">
          <button class="btn primary share-send" data-plan="${p.id}">Send</button>
          <button class="btn share-cancel">Cancel</button>
          <span class="share-msg hint"></span>
        </div>
        <p class="hint">They'll see it under “Shared with you” on their Plans tab.
        The account must already exist.</p>
      </li>` : "";
    return `
      <li class="plan-row" data-plan="${p.id}">
        <div class="plan-row-main">
          <strong>${p.name}</strong>
          <span class="hint">${p.weeks.length} weeks · ${days} days${p.sharedFrom ? ` · from ${esc(p.sharedFrom)}` : ""}${used ? ` · used by ${used} schedule${used === 1 ? "" : "s"}` : ""}</span>
        </div>
        <div class="plan-row-actions">
          <button class="btn use-plan" data-plan="${p.id}">Use this plan</button>
          <button class="btn edit-plan" data-plan="${p.id}">Edit</button>
          <button class="btn share-plan" data-plan="${p.id}">Share</button>
          <button class="btn export-md" data-plan="${p.id}" title="Export as Markdown">md</button>
          <button class="btn export-pdf" data-plan="${p.id}" title="Export as PDF (print dialog)">pdf</button>
          <button class="btn danger delete-plan" data-plan="${p.id}">Delete</button>
        </div>
      </li>${shareForm}`;
  };

  el.innerHTML = `
    <div class="settings-card" id="shared-inbox" hidden>
      <h2>Shared with you</h2>
      <ul class="plan-list" id="shares-list"></ul>
    </div>
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
      <h2>Build your own</h2>
      <p>Write a plan directly in the app — one text box per day, week by week.
      Day types (rest / easy / workout / long run / race) are detected from what you write.</p>
      <button id="open-builder" class="btn primary">Build a plan</button>
    </div>
    <div class="settings-card">
      <h2>Plan library</h2>
      ${userPlans.length
        ? `<ul class="plan-list">${userPlans.map(planRow).join("")}</ul>`
        : '<p class="hint">no plans yet — upload one above or build one from scratch.</p>'}
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
  $("#open-builder").addEventListener("click", () => openBuilder(null));
  $$(".edit-plan", el).forEach((b) => {
    b.addEventListener("click", () => openBuilder(getPlan(b.dataset.plan)));
  });

  // share / export
  $$(".share-plan", el).forEach((b) => {
    b.addEventListener("click", () => {
      sharePlanId = sharePlanId === b.dataset.plan ? null : b.dataset.plan;
      render();
      const input = $(".share-email");
      if (input) input.focus();
    });
  });
  const shareCancel = $(".share-cancel", el);
  if (shareCancel) {
    shareCancel.addEventListener("click", () => {
      sharePlanId = null;
      render();
    });
  }
  const shareSend = $(".share-send", el);
  if (shareSend) {
    shareSend.addEventListener("click", async () => {
      const email = $(".share-email").value.trim();
      const msgEl = $(".share-msg");
      msgEl.classList.remove("sync-error");
      if (!email) {
        msgEl.textContent = "Enter an email address.";
        msgEl.classList.add("sync-error");
        return;
      }
      msgEl.textContent = "Sending…";
      try {
        const res = await fetch("/api/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, plan: state.plans[shareSend.dataset.plan] }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          msgEl.textContent = `Sent to ${email} ✓`;
          $(".share-email").value = "";
        } else {
          msgEl.textContent = {
            recipient_not_found: "No account with that email — they need to sign up first.",
            cannot_share_with_self: "That's you — share it with someone else.",
            inbox_full: "Their share inbox is full.",
            recipient_unverified: "That account hasn't confirmed its email address yet.",
            invalid_email: "That doesn't look like an email address.",
            too_many_attempts: "Too many shares — wait a few minutes.",
          }[data.error] || "Couldn't send — try again.";
          msgEl.classList.add("sync-error");
        }
      } catch {
        msgEl.textContent = "Can't reach the server.";
        msgEl.classList.add("sync-error");
      }
    });
  }
  $$(".export-md", el).forEach((b) => {
    b.addEventListener("click", () => exportPlanMarkdown(getPlan(b.dataset.plan)));
  });
  $$(".export-pdf", el).forEach((b) => {
    b.addEventListener("click", () => exportPlanPdf(getPlan(b.dataset.plan)));
  });

  refreshShares();
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

/* Fetch incoming shares and populate the "Shared with you" card (the Plans
 * panel renders synchronously; this fills in when the request lands). */
async function refreshShares() {
  if (!user) return;
  let shares;
  try {
    const res = await fetch("/api/shares");
    if (!res.ok) return;
    shares = (await res.json()).shares || [];
  } catch {
    return; // offline — the card just stays hidden
  }
  sharesCache = shares;
  const card = $("#shared-inbox");
  if (!card) return; // user navigated away from the Plans tab
  if (!shares.length) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("#shares-list").innerHTML = shares.map((s) => {
    const weeks = Array.isArray(s.plan?.weeks) ? s.plan.weeks.length : "?";
    const name = esc(htmlToPlainText(s.plan?.name).slice(0, 80) || "Plan");
    return `
      <li class="plan-row">
        <div class="plan-row-main">
          <strong>${name}</strong>
          <span class="hint">${weeks} weeks · shared by ${esc(s.fromEmail)}</span>
        </div>
        <div class="plan-row-actions">
          <button class="btn primary accept-share" data-id="${s.id}">Accept</button>
          <button class="btn dismiss-share" data-id="${s.id}">Dismiss</button>
        </div>
      </li>`;
  }).join("");

  const dismiss = (id) =>
    fetch("/api/shares/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});

  $$(".accept-share", card).forEach((b) => {
    b.addEventListener("click", async () => {
      const share = sharesCache.find((s) => s.id === b.dataset.id);
      if (!share) return;
      try {
        const clean = sanitizeSharedPlan(share.plan);
        pendingPlanId = storeParsedPlan({ ...clean, sharedFrom: share.fromEmail }).id;
      } catch (e) {
        alert(`Couldn't import this shared plan: ${e.message}`);
        return;
      }
      await dismiss(share.id);
      render();
    });
  });
  $$(".dismiss-share", card).forEach((b) => {
    b.addEventListener("click", async () => {
      await dismiss(b.dataset.id);
      render();
    });
  });
}

/* ----- in-app plan builder ----- */

const DEFAULT_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* Extract plain text from stored/foreign HTML via an inert DOM (DOMParser
 * never loads resources or runs script); anchors become markdown links. */
function htmlToPlainText(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href") || "";
    a.replaceWith(/^https?:\/\//.test(href) ? `[${a.textContent}](${href})` : a.textContent);
  });
  return (doc.body.textContent || "").trim();
}

/* Reconstruct editable text from a stored day (details hold sanitized HTML). */
function dayCellText(day) {
  return day.details.map(htmlToPlainText).join(" ");
}

function openBuilder(plan) {
  builder = plan
    ? {
        name: plainPlanName(plan.name),
        dayHeaders: plan.dayHeaders?.length ? plan.dayHeaders.slice() : DEFAULT_HEADERS.slice(),
        rows: plan.sourceCells
          ? plan.sourceCells.map((r) => r.slice())
          : plan.weeks.map((w) => w.days.map((d) => (d.type === "rest" && d.details.join() === "Rest." ? "" : dayCellText(d)))),
        editingPlanId: plan.id,
      }
    : {
        name: "",
        dayHeaders: DEFAULT_HEADERS.slice(),
        rows: [Array(7).fill("")],
        editingPlanId: null,
      };
  activeTab = "plans";
  render();
}

function renderBuilder(el) {
  const dpw = builder.dayHeaders.length;
  const weekEditor = (row, wi) => `
    <fieldset class="builder-week">
      <legend>week ${wi + 1}</legend>
      <div class="builder-grid">
        ${builder.dayHeaders.map((h, di) => `
          <label>${h}
            <textarea rows="3" data-w="${wi}" data-d="${di}"
              placeholder="rest">${esc(row[di] || "")}</textarea>
          </label>`).join("")}
      </div>
    </fieldset>`;

  el.innerHTML = `
    <div class="settings-card">
      <div class="builder-head">
        <h2>${builder.editingPlanId ? "Edit plan" : "Build a plan"}</h2>
        <button id="builder-back" class="btn">← back to library</button>
      </div>
      <label class="builder-name">Plan name
        <input type="text" id="builder-name" maxlength="120"
               placeholder="e.g. My 10-Week Base Block" value="${esc(builder.name)}">
      </label>
      <div id="builder-weeks">${builder.rows.map(weekEditor).join("")}</div>
      <div class="inline-controls">
        <button id="builder-add-week" class="btn">+ add week</button>
        <button id="builder-dup-week" class="btn">duplicate last week</button>
        ${builder.rows.length > 1 ? '<button id="builder-del-week" class="btn danger">remove last week</button>' : ""}
      </div>
      <p class="hint">Leave a day blank for a rest day. Day types are detected from the
      text — “6 x 800 at 10k effort” reads as a workout, “Long run: 16 mi” as a long run.
      Links like [name](https://…) stay clickable.</p>
      <div class="inline-controls">
        <button id="builder-save" class="btn primary">Save plan</button>
        <span id="builder-msg" class="hint"></span>
      </div>
    </div>`;

  // oninput (not addEventListener) so re-renders replace rather than stack
  el.oninput = (ev) => {
    if (ev.target.matches(".builder-week textarea")) {
      builder.rows[Number(ev.target.dataset.w)][Number(ev.target.dataset.d)] = ev.target.value;
    } else if (ev.target.id === "builder-name") {
      builder.name = ev.target.value;
    }
  };

  $("#builder-back", el).addEventListener("click", () => {
    builder = null;
    render();
  });
  $("#builder-add-week", el).addEventListener("click", () => {
    builder.rows.push(Array(dpw).fill(""));
    render();
  });
  $("#builder-dup-week", el).addEventListener("click", () => {
    builder.rows.push(builder.rows[builder.rows.length - 1].slice());
    render();
  });
  const delBtn = $("#builder-del-week", el);
  if (delBtn) {
    delBtn.addEventListener("click", () => {
      const last = builder.rows[builder.rows.length - 1];
      if (last.some((c) => c.trim()) && !confirm("The last week has workouts in it — remove it anyway?")) return;
      builder.rows.pop();
      render();
    });
  }

  $("#builder-save", el).addEventListener("click", () => {
    const msg = $("#builder-msg");
    msg.classList.remove("sync-error");
    try {
      const parsed = PlanParser.buildPlan(builder.name, builder.rows, builder.dayHeaders);
      const sourceCells = builder.rows.map((r) => r.slice());
      if (builder.editingPlanId) {
        const inUse = liveSchedules().filter((s) => s.planId === builder.editingPlanId);
        if (inUse.length &&
            !confirm(`This plan is used by: ${inUse.map((s) => s.name).join(", ")}. Saving updates those schedules — journal entries stay attached by day position. Continue?`)) {
          return;
        }
        const existing = state.plans[builder.editingPlanId];
        state.plans[builder.editingPlanId] = {
          id: builder.editingPlanId,
          ...parsed,
          sourceCells,
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        pendingPlanId = builder.editingPlanId;
        saveState();
      } else {
        pendingPlanId = storeParsedPlan({ ...parsed, sourceCells }).id;
      }
      builder = null;
      render();
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.add("sync-error");
    }
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
          <button class="btn export-ics" data-sched="${s.id}" title="Export to calendar (.ics)">ics</button>
          <button class="btn danger delete-sched" data-sched="${s.id}">Delete</button>
        </div>
      </li>`;
  };

  const syncLine = syncStatus.error
    ? `<span class="sync-error">⚠ Offline (${esc(syncStatus.error)}) — changes are saved on this device and will sync when the server is reachable.</span>`
    : (syncStatus.lastSync ? `Synced ${new Date(syncStatus.lastSync).toLocaleString()}` : "Not synced yet this session");

  const firstRun = !scheds.length;
  const unverified = user.verificationRequired && user.emailVerified === false;
  const verifyLine = verifyNotice
    ? `<p class="hint verify-ok" id="verify-line">${esc(verifyNotice)}</p>`
    : unverified
      ? `<p class="hint sync-error" id="verify-line">Your email isn't confirmed yet, so
          training partners can't share plans with you. Check your inbox for the link.</p>`
      : "";
  const accountCard = `
    <div class="settings-card">
      <h2>Account</h2>
      <p>Signed in as <strong>${esc(user.email)}</strong>. Your plans, schedules, and
      journals are stored in your account — sign in anywhere to get them.</p>
      ${verifyLine}
      <p class="hint" id="account-sync-status">${syncLine}</p>
      <div class="inline-controls">
        <button id="sync-now" class="btn">Sync now</button>
        ${unverified ? '<button id="resend-verify" class="btn">Resend confirmation</button>' : ""}
        <button id="logout" class="btn">Log out</button>
      </div>
    </div>`;
  const newScheduleCard = `
    <div class="settings-card ${firstRun ? "is-first-run" : ""}">
      <details id="new-schedule-details" ${firstRun ? "open" : ""}>
        <summary><h2 class="summary-h2">${firstRun ? "Welcome! Set up your training schedule" : "New schedule"}</h2></summary>
        ${firstRun ? `<p>Three quick steps: upload your training plan (PDF, Markdown, or
          JSON) or build one from scratch, choose how it lands on the calendar, and enter
          your race date — then the Today tab shows every day's workout.</p>` : ""}
        ${scheduleFormHTML()}
      </details>
    </div>`;

  el.innerHTML = `
    ${firstRun ? newScheduleCard + accountCard : accountCard + newScheduleCard}
    ${paceCardHTML()}
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
      <h2>Danger zone</h2>
      <p class="hint">Clearing your training data keeps your account; deleting the
      account removes everything permanently.</p>
      <div class="inline-controls">
        <button id="reset-all" class="btn danger">Clear plans, schedules &amp; journals</button>
        <button id="delete-account" class="btn danger">Delete my account</button>
      </div>
      <div id="delete-account-confirm" hidden>
        <p class="hint sync-error">This permanently deletes your account, every plan,
        schedule and journal entry, and any pending shares. It cannot be undone —
        export a backup first if you want a copy.</p>
        <div class="inline-controls">
          <input type="password" id="delete-password" placeholder="confirm your password"
                 autocomplete="current-password">
          <button id="delete-account-go" class="btn danger">Delete permanently</button>
          <button id="delete-account-cancel" class="btn">Cancel</button>
          <span id="delete-msg" class="hint"></span>
        </div>
      </div>
    </div>`;

  wireScheduleForm(el);
  wirePaceCard();

  $("#sync-now").addEventListener("click", async () => {
    $("#account-sync-status").textContent = "Syncing…";
    await doSync();
    render();
  });
  $("#logout").addEventListener("click", logout);
  const resend = $("#resend-verify");
  if (resend) {
    resend.addEventListener("click", async () => {
      const line = $("#verify-line");
      resend.disabled = true;
      try {
        const res = await fetch("/api/verify/resend", { method: "POST" });
        line.textContent = res.ok
          ? "Confirmation link sent — check your inbox."
          : "Couldn't send it just now; try again in a minute.";
        line.classList.toggle("sync-error", !res.ok);
      } catch {
        line.textContent = "Can't reach the server.";
      } finally {
        resend.disabled = false;
      }
    });
  }

  $$(".activate-sched", el).forEach((b) => {
    b.addEventListener("click", () => {
      state.activeScheduleId = b.dataset.sched;
      state.activeUpdatedAt = new Date().toISOString();
      saveState();
      render();
    });
  });
  $$(".export-ics", el).forEach((b) => {
    b.addEventListener("click", () => {
      const s = state.schedules[b.dataset.sched];
      const info = s && schedInfo(s);
      if (!info) return;
      downloadFile(
        `${plainPlanName(s.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "schedule"}.ics`,
        scheduleToICS(info),
        "text/calendar",
      );
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
      materializeLegacySwapPlan();
      saveState();
      render();
      alert("Import complete!");
    } catch {
      alert("Sorry, that file doesn't look like a marathon-tracker backup.");
    }
  });

  $("#delete-account").addEventListener("click", () => {
    $("#delete-account-confirm").hidden = false;
    $("#delete-password").focus();
  });
  $("#delete-account-cancel").addEventListener("click", () => {
    $("#delete-account-confirm").hidden = true;
    $("#delete-password").value = "";
  });
  $("#delete-account-go").addEventListener("click", async () => {
    const msg = $("#delete-msg");
    const password = $("#delete-password").value;
    if (!password) {
      msg.textContent = "Enter your password to confirm.";
      msg.classList.add("sync-error");
      return;
    }
    if (!confirm("Delete your account and all training data permanently?")) return;
    msg.classList.remove("sync-error");
    msg.textContent = "Deleting…";
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        msg.textContent = data.error === "wrong_password"
          ? "That password isn't right." : "Couldn't delete the account — try again.";
        msg.classList.add("sync-error");
        return;
      }
      // nothing left to sync; drop every local trace of this account
      clearTimeout(syncTimer);
      pushPending = false;
      localStorage.removeItem(syncMetaKey());
      localStorage.removeItem(cacheKey());
      localStorage.removeItem(LAST_USER_KEY);
      user = null;
      state = emptyState();
      authMode = "login";
      render();
      setAuthMode("login", "Your account and all its data have been deleted.");
    } catch {
      msg.textContent = "Can't reach the server.";
      msg.classList.add("sync-error");
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

/* ----- day swapping (modal controls) ----- */

function swapRowHTML(info, i) {
  const week = info.weeks.find((w) => i >= w.firstIdx && i <= w.lastIdx);
  if (!week || week.days.length < 2) return "";
  const options = [];
  for (let j = week.firstIdx; j <= week.lastIdx; j++) {
    if (j === i) continue;
    const d = info.days[j];
    options.push(`<option value="${j}">${FMT_MED.format(addDays(info.start, j))} — ${plainPlanName(d.title).slice(0, 44)}</option>`);
  }
  const day = info.days[i];
  const undo = day.swappedFrom !== undefined
    ? `<button type="button" class="btn" id="swap-undo" data-target="${day.swappedFrom}">undo swap</button>` : "";
  return `
    <div class="swap-row">
      <span class="swap-label">life happens — swap with:</span>
      <select id="swap-target">${options.join("")}</select>
      <button type="button" class="btn" id="swap-btn">⇄ swap days</button>
      ${undo}
    </div>`;
}

/* ----- pace-zones settings card ----- */

function paceCardHTML() {
  const p = state.profile;
  const vdot = currentVdot();
  let summary = "";
  if (vdot) {
    const z = currentZones();
    const fp = PaceEngine.formatPaceSec;
    const fc = PaceEngine.formatClock;
    const eq = (m) => fc(PaceEngine.equivalentRaceTime(vdot, m));
    let goalNote = "";
    const goalSecs = p.goalTime ? parseDuration(p.goalTime) : null;
    if (goalSecs) {
      const predicted = PaceEngine.equivalentRaceTime(vdot, 42195);
      const goalVdot = PaceEngine.vdotFromRace(42195, goalSecs);
      const goalPace = fp(goalSecs / 26.21875);
      goalNote = goalSecs < predicted * 0.98
        ? `<p class="hint sync-error" id="goal-note">⚠ Goal ${esc(p.goalTime)} (${goalPace}/mi) needs
            VDOT ${goalVdot ? goalVdot.toFixed(1) : "?"} — your current race result predicts
            ${fc(predicted)}. Zones stay pinned to current fitness; retest (the week-9 tempo
            is perfect for this) and update here as fitness improves.</p>`
        : `<p class="hint" id="goal-note">Goal ${esc(p.goalTime)} = ${goalPace}/mi — consistent with
            current fitness (predicted ${fc(predicted)}).</p>`;
    }
    summary = `
      <p>VDOT <strong>${vdot.toFixed(1)}</strong> · equivalent races:
        5k ${eq(5000)} · 10k ${eq(10000)} · half ${eq(21097.5)} · marathon ${eq(42195)}</p>
      <div class="pace-row">
        <span class="pace-chip"><b>easy</b> ${fp(z.easySlow)}–${fp(z.easyFast)}/mi</span>
        <span class="pace-chip"><b>M</b> ${fp(z.M)}/mi</span>
        <span class="pace-chip"><b>T</b> ${fp(z.T)}/mi</span>
        <span class="pace-chip"><b>10k</b> ${fp(z.tenK)}/mi</span>
        <span class="pace-chip"><b>5k</b> ${fp(z.fiveK)}/mi</span>
        <span class="pace-chip"><b>3k</b> ${fp(z.threeK)}/mi</span>
      </div>
      ${goalNote}`;
  }
  return `
    <div class="settings-card" id="pace-card">
      <h2>Pace zones</h2>
      <p class="hint">Zones follow the Daniels VDOT model, computed from a <strong>recent race
      result</strong> — the fresher the better. A goal time never changes the zones: train where
      you are, not where you hope to be.</p>
      ${summary}
      <div class="inline-controls">
        <select id="pace-dist">
          ${["5k", "10k", "half", "marathon"].map((d) =>
            `<option value="${d}" ${p?.raceDist === d ? "selected" : ""}>${d === "half" ? "half marathon" : d}</option>`).join("")}
        </select>
        <input type="text" id="pace-time" placeholder="race time (19:57 or 1:31:35)"
               value="${esc(p?.raceTime || "")}">
        <input type="text" id="pace-goal" placeholder="goal marathon (optional)"
               value="${esc(p?.goalTime || "")}">
        <button id="pace-save" class="btn primary">Save</button>
        <span id="pace-msg" class="hint"></span>
      </div>
    </div>`;
}

function wirePaceCard() {
  $("#pace-save").addEventListener("click", () => {
    const msgEl = $("#pace-msg");
    msgEl.classList.remove("sync-error");
    const raceDist = $("#pace-dist").value;
    const raceTime = $("#pace-time").value.trim();
    const goalTime = $("#pace-goal").value.trim();
    const secs = parseDuration(raceTime);
    if (!secs) {
      msgEl.textContent = "Enter the race time as mm:ss or h:mm:ss.";
      msgEl.classList.add("sync-error");
      return;
    }
    if (!PaceEngine.vdotFromRace(PaceEngine.RACE_DISTANCES[raceDist], secs)) {
      msgEl.textContent = "That time doesn't look plausible for that distance — double-check both.";
      msgEl.classList.add("sync-error");
      return;
    }
    if (goalTime && !parseDuration(goalTime)) {
      msgEl.textContent = "Goal time should look like 3:05:00.";
      msgEl.classList.add("sync-error");
      return;
    }
    state.profile = {
      raceDist, raceTime,
      goalTime: goalTime || null,
      updatedAt: new Date().toISOString(),
    };
    saveState();
    render();
  });
}

/* ----- second session (optional double / cross-training / strength) -----
 * Many plans suggest an optional second activity ("optional uphill TM or
 * x-train double", "full strength routine"). Entries carry an optional
 * `second` object; only running kinds add to weekly running mileage. */
const SECOND_KINDS = {
  double:     { label: "easy double (run)",   run: true },
  treadmill:  { label: "uphill treadmill",    run: true },
  bike:       { label: "x-train — bike",      run: false },
  elliptical: { label: "x-train — elliptical", run: false },
  swim:       { label: "x-train — swim",      run: false },
  xtrain:     { label: "x-train — other",     run: false },
  strength:   { label: "strength",            run: false },
  other:      { label: "other",               run: false },
};

function secondOf(entry) {
  const s = entry && entry.second;
  if (!s) return null;
  return (s.kind || s.distance || s.duration || s.notes) ? s : null;
}

function secondIsRun(second) {
  return Boolean(second && SECOND_KINDS[second.kind]?.run);
}

function secondSummary(second) {
  const bits = [];
  if (second.kind) bits.push(SECOND_KINDS[second.kind]?.label || second.kind);
  // cross-training is measured in time, not distance
  if (secondIsRun(second) && second.distance) bits.push(`${second.distance} mi`);
  if (second.duration) bits.push(second.duration);
  return bits.join(" · ") || "second session";
}

/* Compact h:mm for accumulated training time. */
function formatHoursMin(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return m === 60 ? `${h + 1}:00` : `${h}:${String(m).padStart(2, "0")}`;
}

/* Does the plan itself suggest an optional second activity this day? */
function daySuggestsSecond(day) {
  return /\bdouble\b|x-train|cross-?train|uphill (tm|treadmill)|strength/i
    .test(`${day.title} ${day.details.join(" ")}`);
}

/* ----- GPX import (watch / Strava "Export GPX") ----- */

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That doesn't look like a valid GPX file.");
  const pts = [...doc.getElementsByTagName("trkpt")];
  if (pts.length < 2) throw new Error("No GPS track points found — export the activity as GPX (Strava: activity → ⋯ → Export GPX).");
  let meters = 0;
  let prev = null;
  let firstMs = null, lastMs = null;
  for (const pt of pts) {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (prev) meters += haversineMeters(prev.lat, prev.lon, lat, lon);
    prev = { lat, lon };
    const t = pt.getElementsByTagName("time")[0]?.textContent;
    if (t) {
      const ms = Date.parse(t);
      if (!Number.isNaN(ms)) {
        if (firstMs === null) firstMs = ms;
        lastMs = ms;
      }
    }
  }
  const miles = meters / 1609.344;
  if (miles < 0.05) throw new Error("This GPX barely moves — is it the right activity?");
  const seconds = firstMs !== null && lastMs > firstMs ? (lastMs - firstMs) / 1000 : null;
  return { miles, seconds, start: firstMs !== null ? new Date(firstMs) : null };
}

function formatDurationInput(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/* ----- Day detail modal + journal form ----- */

function openDay(i) {
  const info = activeInfo();
  if (!info || !info.days[i]) return;
  const day = info.days[i];
  const date = addDays(info.start, i);
  const entry = entryFor(i) || {};
  const existingSecond = secondOf(entry);
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
      ${day.swappedFrom !== undefined
        ? `<span class="type-tag swap-tag">⇄ moved from ${FMT_MED.format(addDays(info.start, day.swappedFrom))}</span>` : ""}
    </div>
    <h2 id="modal-title">${day.title}</h2>
    <div class="workout-details">${details}</div>
    ${paceChipsHTML(day)}
    ${swapRowHTML(info, i)}
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
                 value="${esc(entry.duration ?? "")}" placeholder="type digits: 4530 → 45:30">
        </label>
        <label>Effort (RPE 1–10)
          <select name="rpe">${rpeOptions}</select>
        </label>
      </div>
      <div class="inline-controls gpx-row">
        <label class="btn">import .gpx (watch / strava export)<input type="file" class="gpx-file" accept=".gpx" hidden></label>
        <span class="gpx-msg hint"></span>
      </div>
      <div class="pace-line" id="pace-line"></div>
      <div class="rating-line"><span>Felt like:</span><div class="stars" id="stars">${ratingButtons}</div></div>
      <label class="notes-label">Notes — splits, times, weather, fueling, how the legs felt…
        <textarea name="notes" rows="5" placeholder="e.g. 6 × 5min at 6:45 pace, 2min jog. Warm out. Felt strong on the last two reps.">${esc(entry.notes ?? "")}</textarea>
      </label>
      <details class="second-block" id="second-block" ${existingSecond || daySuggestsSecond(day) ? "open" : ""}>
        <summary>
          <span class="summary-h3">// second session</span>
          <span class="hint second-hint">${existingSecond
            ? esc(secondSummary(existingSecond))
            : "double, cross-training, or strength — optional"}</span>
        </summary>
        <div class="form-grid">
          <label>Activity
            <select name="secondKind">
              <option value="">— none —</option>
              ${Object.entries(SECOND_KINDS).map(([k, v]) =>
                `<option value="${k}" ${existingSecond?.kind === k ? "selected" : ""}>${v.label}</option>`).join("")}
            </select>
          </label>
          <label>Distance (miles)
            <input type="number" name="secondDistance" min="0" max="200" step="0.1"
                   value="${existingSecond?.distance ?? ""}" placeholder="runs only">
          </label>
          <label>Time<span class="second-time-req"></span>
            <input type="text" name="secondDuration" inputmode="numeric" pattern="[0-9:]*"
                   value="${esc(existingSecond?.duration ?? "")}" placeholder="type digits: 4500 → 45:00">
          </label>
          <label>Notes
            <input type="text" name="secondNotes" maxlength="300"
                   value="${esc(existingSecond?.notes ?? "")}" placeholder="e.g. 45 min Z2, 12% grade">
          </label>
        </div>
        <div class="inline-controls gpx-row">
          <label class="btn">import .gpx<input type="file" class="gpx-file-second" accept=".gpx" hidden></label>
          <span class="gpx-msg-second hint"></span>
        </div>
        <div class="pace-line" id="second-pace-line"></div>
        <p class="hint">Only running kinds (easy double, uphill treadmill) count toward weekly
        mileage; cross-training and strength are tracked separately.</p>
      </details>
      <div class="modal-actions">
        <button type="submit" class="btn primary">Save entry</button>
        ${entry.status || entry.notes || entry.distance || existingSecond ? '<button type="button" id="clear-entry" class="btn danger">Delete entry</button>' : ""}
        <span id="save-confirm" class="save-confirm" hidden>Saved ✓</span>
      </div>
    </form>`;

  let rating = entry.rating || 0;
  /* Cross-training and strength are measured in time, so distance is only
   * offered for running kinds — no silently-dropped input. */
  const syncSecondFields = () => {
    const form = $("#journal-form");
    const kind = form.secondKind.value;
    const isRun = !kind || SECOND_KINDS[kind]?.run;
    form.secondDistance.disabled = !isRun;
    form.secondDistance.placeholder = isRun ? "runs only" : "n/a — time only";
    if (!isRun) form.secondDistance.value = "";
    $(".second-time-req").textContent = isRun ? "" : " — how it's tracked";
  };
  const updatePace = () => {
    const form = $("#journal-form");
    const dist = parseFloat(form.distance.value);
    const secs = parseDuration(form.duration.value);
    $("#pace-line").textContent =
      dist > 0 && secs ? `Average pace: ${formatPace(secs / dist)}` : "";
    const d2 = parseFloat(form.secondDistance.value);
    const s2 = parseDuration(form.secondDuration.value);
    $("#second-pace-line").textContent =
      d2 > 0 && s2 ? `Average pace: ${formatPace(s2 / d2)}` : "";
  };
  syncSecondFields();
  updatePace();
  $("#journal-form").addEventListener("input", () => {
    syncSecondFields();
    updatePace();
  });
  // Colons appear as you type, so the field always shows what will be saved
  // (typing 012133 gives 01:21:33). Phone keypads have no colon key.
  $$('#journal-form input[name="duration"], #journal-form input[name="secondDuration"]')
    .forEach((input) => {
      input.addEventListener("input", () => {
        const atEnd = input.selectionStart === input.value.length;
        const masked = PaceEngine.maskDuration(input.value);
        if (masked !== input.value) {
          input.value = masked;
          // typing is almost always an append; keep the caret with it
          if (atEnd) input.setSelectionRange(masked.length, masked.length);
        }
        updatePace();
      });
      input.addEventListener("blur", () => {
        const tidy = PaceEngine.normalizeDuration(input.value);
        if (tidy && tidy !== input.value.trim()) {
          input.value = tidy;
          updatePace();
        }
      });
    });

  $(".gpx-file", modal).addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const form = $("#journal-form");
    const msgEl = $(".gpx-msg", modal);
    msgEl.classList.remove("sync-error");
    try {
      const gpx = parseGpx(await file.text());
      form.distance.value = gpx.miles.toFixed(1);
      if (gpx.seconds) form.duration.value = formatDurationInput(gpx.seconds);
      if (!form.status.value) form.status.value = "completed";
      updatePace();
      let msg = `imported ${gpx.miles.toFixed(2)} mi${gpx.seconds ? ` · ${formatDurationInput(gpx.seconds)} elapsed` : ""}`;
      if (gpx.start && toISODate(gpx.start) !== toISODate(date)) {
        msg += ` — heads up: activity is from ${FMT_MED.format(gpx.start)}`;
      }
      msgEl.textContent = msg;
    } catch (e) {
      msgEl.textContent = e.message;
      msgEl.classList.add("sync-error");
    }
    ev.target.value = "";
  });

  $(".gpx-file-second", modal).addEventListener("change", async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const form = $("#journal-form");
    const msgEl = $(".gpx-msg-second", modal);
    msgEl.classList.remove("sync-error");
    try {
      const gpx = parseGpx(await file.text());
      // a GPS track is a run unless the athlete already said otherwise
      if (!form.secondKind.value) form.secondKind.value = "double";
      syncSecondFields();
      if (!form.secondDistance.disabled) form.secondDistance.value = gpx.miles.toFixed(1);
      if (gpx.seconds) form.secondDuration.value = formatDurationInput(gpx.seconds);
      updatePace();
      msgEl.textContent = `imported ${gpx.miles.toFixed(2)} mi${gpx.seconds ? ` · ${formatDurationInput(gpx.seconds)} elapsed` : ""}`;
    } catch (e) {
      msgEl.textContent = e.message;
      msgEl.classList.add("sync-error");
    }
    ev.target.value = "";
  });

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
    const secondKind = form.secondKind.value || "";
    const secondTracksMiles = !secondKind || SECOND_KINDS[secondKind]?.run;
    const second = {
      kind: secondKind,
      // never store miles against a cross-training or strength session
      distance: secondTracksMiles && form.secondDistance.value
        ? Number(form.secondDistance.value) : null,
      duration: form.secondDuration.value.trim() || null,
      notes: form.secondNotes.value.trim() || null,
    };
    const entryOut = {
      status: form.status.value || "",
      distance: form.distance.value ? Number(form.distance.value) : null,
      duration: form.duration.value.trim() || null,
      rpe: form.rpe.value ? Number(form.rpe.value) : null,
      rating: rating || null,
      notes: form.notes.value.trim() || null,
      second: secondOf({ second }) ? second : null,
      updatedAt: new Date().toISOString(),
    };
    const hasContent = entryOut.status || entryOut.distance || entryOut.duration ||
      entryOut.rpe || entryOut.rating || entryOut.notes || entryOut.second;
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

  const swapBtn = $("#swap-btn");
  if (swapBtn) {
    swapBtn.addEventListener("click", () => {
      swapDays(state.activeScheduleId, i, Number($("#swap-target").value));
      closeModal();
      render();
    });
  }
  const swapUndo = $("#swap-undo");
  if (swapUndo) {
    swapUndo.addEventListener("click", () => {
      swapDays(state.activeScheduleId, i, Number(swapUndo.dataset.target));
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

/* Links arrive as /?reset=<token> or /?verify=<token>. Consume the token and
 * strip it from the URL so it never lingers in history or a shared screenshot. */
async function consumeEmailLink() {
  const params = new URLSearchParams(location.search);
  const reset = params.get("reset");
  const verify = params.get("verify");
  if (!reset && !verify) return null;
  history.replaceState(null, "", location.pathname);
  if (reset) {
    pendingResetToken = reset;
    return { mode: "reset" };
  }
  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verify }),
    });
    return { verified: res.ok };
  } catch {
    return { verified: false };
  }
}

async function boot() {
  const link = await consumeEmailLink();
  if (link && link.mode === "reset") {
    user = null;
    setAuthMode("reset");
    render();
    return; // the reset form is the whole screen until it succeeds
  }
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
    if (link && link.verified !== undefined) {
      setAuthMode("login", link.verified
        ? "Email confirmed — sign in to continue."
        : "That confirmation link has expired or was already used.");
    }
    return;
  }
  if (link && link.verified) {
    user = { ...user, emailVerified: true };
    verifyNotice = "Email confirmed ✓";
  }
  state = loadCache() || emptyState();
  syncMeta = loadSyncMeta();
  migrateLegacyState();
  materializeLegacySwapPlan();
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
    setAuthMode(authMode === "login" ? "register" : "login");
  });
  $("#auth-forgot-link").addEventListener("click", (ev) => {
    ev.preventDefault();
    setAuthMode("forgot");
  });

  $$("#tabs button").forEach((b) => {
    b.addEventListener("click", () => {
      activeTab = b.dataset.tab;
      render();
    });
  });

  // Day cards / schedule rows (delegated); quick-log wins over opening the modal
  document.addEventListener("click", (ev) => {
    const quick = ev.target.closest("[data-quicklog]");
    if (quick) {
      setEntry(Number(quick.dataset.quicklog), {
        status: "completed",
        updatedAt: new Date().toISOString(),
      });
      saveState();
      render();
      return;
    }
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

  // pull latest data whenever the tab regains focus; flush unpushed
  // changes when it's hidden or being torn down
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushPendingPush();
    } else if (user && !$("#day-modal").open) {
      doSync().then(() => {
        if (!$("#day-modal").open) render();
      });
    }
  });
  window.addEventListener("pagehide", flushPendingPush);

  // charts are drawn for a phone- or desktop-sized viewBox, so redraw when a
  // rotation or resize crosses that breakpoint
  let wasNarrow = isNarrowViewport();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowNarrow = isNarrowViewport();
      if (nowNarrow !== wasNarrow) {
        wasNarrow = nowNarrow;
        if (activeTab === "progress" && !$("#day-modal").open) render();
      }
    }, 200);
  });

  // PWA: offline shell + installability (silent no-op where unsupported)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  boot();
});
