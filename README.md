# MARATHON//TRAINER

A multi-user web app for running training plans. Sign in, pick or upload a
training plan, anchor it to the calendar — working backward from your goal race
or forward from a start date — then see each day's workout and journal how it
went to track your progress.

## Features

- **Accounts** — email + password sign-in; every user's plans, schedules, and
  journals are stored server-side, so you can sign in from any device and share
  the app with training partners.
- **Plan library** — every user starts with an empty library (no pre-imported
  plan) and fills it their way: upload a **PDF** (grid-style plans; the table
  is reconstructed from the text layout), a markdown table, or JSON
  (see [docs/plan-format.md](docs/plan-format.md)) — or **build a plan
  directly in the app**, one text box per day, with add/duplicate-week
  controls and editing of saved plans. Day types (rest / easy / workout /
  long run / race) are detected automatically either way.
  (`plans/swap-12-week-marathon.md` ships as an example file to upload.)
- **Flexible scheduling with Monday-aligned weeks** — create any number of
  schedules from any plan: either **work backward from a goal race** or
  **start on a date**. Training weeks always align to real calendar weeks
  (Monday–Sunday for Mon-first plans): start dates snap forward to the next
  Monday, and in race mode the race lands on its true date inside the final
  week, dropping any unused post-race taper days. Each schedule keeps its own
  journal; switch the active one in Settings.
- **Target pace zones** — enter a recent race result (Daniels VDOT model,
  validated against the published tables); every workout that names an effort
  ("M effort", "1-hour effort", 10k/5k/3k) shows your personal pace inline,
  and goal times get a reality check against current fitness. See FEATURES.md
  for the accuracy notes.
- **Today view** — today's workout front and center, with a race-day countdown
  (or day-X-of-N progress for start-mode schedules).
- **Full schedule** — every week expandable, current week highlighted, days
  color-tagged by type with journal-status dots.
- **Training journal** — per day: completed / modified / skipped, distance,
  total time (average pace computed), effort (RPE 1–10), a star rating, and
  free-form notes for splits, weather, and fueling.
- **Second session** — every day also takes an optional second activity for the
  doubles, cross-training and strength work plans suggest (easy double, uphill
  treadmill, bike/elliptical/swim, strength, other), with its own distance,
  time, notes and GPX import. The block opens automatically on days whose plan
  text mentions one. Running kinds add to weekly mileage; cross-training and
  strength are measured in **time** instead (distance is disabled for them),
  reported in their own X-train column and stat tile.
- **Progress tracking** — days to race, percent through the plan, workouts
  completed, total miles, plan adherence and a day streak, a miles-per-week
  chart with the plan's own range behind it, an average-pace trend, and a
  week-by-week table. Rest days never count against you, and an unlogged
  today doesn't break a streak.
- **Race week** — inside the final seven days the Today tab leads with
  goal-pace splits (5K through the finish) computed from your own race
  result, the fuelling numbers your plan actually specifies plus the total
  they add up to over your predicted finish, and a checklist that syncs. A
  goal ahead of your current fitness is flagged rather than quietly used.
- **Cross-device sync** — changes push automatically and merge by
  most-recent-edit per journal entry (deletions propagate too), with offline
  support via a per-user local cache.
- **Plan sharing** — send any plan to another account by email address; it
  lands in their "Shared with you" inbox on the Plans tab to accept or
  dismiss. Accepted plans are re-sanitized through the same parsing pipeline
  as uploads, so a shared plan can never inject markup into your account.
- **Plan export** — download any plan as a **markdown table** (the app's own
  upload format, so it round-trips) or open a **print-formatted PDF view**
  (the browser's print dialog does "Save as PDF"; the layout is grid-style,
  so even our own PDF importer can read it back).
- **Installable PWA** — add to your phone's home screen and launch standalone;
  the app shell works offline (training data lives in localStorage and
  re-syncs when you're back online).
- **GPX import** — import a `.gpx` from your watch or Strava's "Export GPX"
  straight into a journal entry; it fills distance and elapsed time so logging
  a run is a click, not typing.
- **Backup** — export/import all your data as JSON. Mobile friendly.
- **NEON//GRID design system** — the UI implements the owner's personal
  design system (cyberpunk/synthwave: near-black canvas, neon accents as
  light sources, Orbitron/Rajdhani/Share Tech Mono type, sharp corners,
  glow instead of shadows). Dark-only by design; fonts are self-hosted in
  `fonts/` so the app has no external runtime dependencies.

## Running it

No build step, no npm dependencies — a small Node server (`server.js`) serves
the app and the API.

- **Locally:** `npm start`, then visit `http://localhost:3000`.
- **Railway:** create a new Railway project from this GitHub repo — Railway
  detects the Node app automatically, runs `npm start`, and the server binds to
  Railway's `PORT`. Then open **Settings → Networking → Generate Domain** on the
  service to get your public URL.
  - **Attach a volume** (required for real use): accounts and training data
    live on disk, so add a volume with mount path `/app/data` (the server's
    default data directory), or mount it anywhere and set the `DATA_DIR`
    environment variable to that path. Without a volume, all accounts and data
    are wiped on each redeploy.

## Architecture & data

```
index.html         app shell (auth screen + tabbed app)
css/styles.css     styles (light + dark)
js/plan.js         the built-in SWAP plan as structured data
js/planParser.js   markdown-table, JSON & PDF-grid plan parsing (browser + Node)
js/vendor/         vendored pdf.js (loaded on demand for PDF uploads)
js/app.js          auth, schedules, journal, rendering, chart, sync
server.js          dependency-free static server + JSON API
plans/             example plan file (the built-in plan's source)
docs/              plan format reference
```

**API:** `POST /api/register|login|logout`, `GET /api/me`,
`GET|PUT /api/data` (the signed-in user's state blob), and plan sharing via
`POST /api/share` (deliver to a recipient's inbox by email),
`GET /api/shares`, and `POST /api/shares/dismiss`. Share inboxes are capped
at 50 items and sends are rate-limited. Note: sharing confirms whether an
email has an account — fine for a group of training partners. Sessions are HttpOnly
`SameSite=Lax` cookies (90-day expiry); passwords are scrypt-hashed with
per-user salts; auth endpoints are rate-limited. Each user's data is a JSON
file under `DATA_DIR` — no database to manage.

**Sync model:** the client caches state per user in `localStorage` (offline
works), pulls on load/focus, and pushes ~1.5 s after every change. Merging is
last-write-wins per item (plans, schedules, and individual journal entries each
carry `updatedAt`); deletions are tombstones so they win merges and propagate
to other devices.

Each device also remembers the state as of its last successful sync, so a
merge can tell a genuine conflict — both sides changed the same item since
that point — from an ordinary one-sided edit. Last-write-wins still decides,
but the replaced version is surfaced on the Today tab with both versions shown
and a one-click restore, so an edit made offline never disappears silently.
That bookkeeping is per-device and never leaves the browser.

## Backups

Everything lives on one volume, so a volume loss is the only unrecoverable
failure this app has. Three layers guard it:

1. **Scheduled snapshots** — the server writes a gzipped snapshot of all
   accounts, plans and journals into `DATA_DIR/backups` every 24 h, keeping
   the newest 14. Tune with `BACKUP_INTERVAL_HOURS` (0 disables) and
   `BACKUP_KEEP`. Sessions are deliberately excluded, so a leaked snapshot
   grants nobody a login.
2. **Off-box copies** — set `ADMIN_TOKEN` on the service to enable
   `GET /api/admin/backup` (Bearer auth; the route 404s when the variable is
   unset). `.github/workflows/backup.yml` pulls one nightly and keeps it as a
   GitHub artifact for 90 days — set the `APP_URL` and `ADMIN_TOKEN`
   repository secrets to turn it on.
3. **Manual** — `npm run backup`, `npm run backup:list`.

Restore into a volume with:

```bash
DATA_DIR=/app/data node backup.js --restore path/to/backup.json.gz --force
```

Treat snapshots as sensitive: they contain email addresses and password
hashes (hashes, not passwords).

## Email: password reset & verification

Set `MAIL_PROVIDER=resend` plus `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL`
to send real mail (Resend is a plain HTTPS call, so there's still no npm
dependency). With **no provider configured** the app still works: links are
written to the server log, so an operator can recover an account by reading
the logs instead of editing JSON on the volume.

- **Reset** — "Forgot password?" emails a single-use link that expires in an
  hour. The response is identical whether or not the address has an account,
  so the endpoint never reveals who is registered. Completing a reset also
  invalidates every existing session for that user, in case the reset is a
  recovery from compromise.
- **Verification** — enforced only when mail is actually configured
  (override with `REQUIRE_EMAIL_VERIFICATION`). Until an address is confirmed
  it can't *receive* shared plans, which closes the hole where someone signs
  up with an address they don't own and collects plans meant for its owner.

Only the SHA-256 of each token is stored, so a leaked `tokens.json` cannot be
used to take over an account.

**Limitations to know about:** account deletion isn't implemented yet, and
sharing still confirms whether an address has an account (the reset flow does
not). See FEATURES.md for the prioritized list.
