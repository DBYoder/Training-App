# Marathon Training Tracker 🏃

A multi-user web app for running training plans. Sign in, pick or upload a
training plan, anchor it to the calendar — working backward from your goal race
or forward from a start date — then see each day's workout and journal how it
went to track your progress.

## Features

- **Accounts** — email + password sign-in; every user's plans, schedules, and
  journals are stored server-side, so you can sign in from any device and share
  the app with training partners.
- **Plan library** — the SWAP 12-Week Advanced Marathon Plan is built in, and
  you can upload your own plans as a markdown table or JSON
  (see [docs/plan-format.md](docs/plan-format.md)). Day types
  (rest / easy / workout / long run / race) are detected automatically.
- **Flexible scheduling** — create any number of schedules from any plan:
  either **work backward from a goal race** (the last plan day lands on race
  day) or **start on a date** (day 1 is the date you pick). Each schedule keeps
  its own journal; switch the active one in Settings.
- **Today view** — today's workout front and center, with a race-day countdown
  (or day-X-of-N progress for start-mode schedules).
- **Full schedule** — every week expandable, current week highlighted, days
  color-tagged by type with journal-status dots.
- **Training journal** — per day: completed / modified / skipped, distance,
  total time (average pace computed), effort (RPE 1–10), a star rating, and
  free-form notes for splits, weather, and fueling.
- **Progress tracking** — days to race, percent through the plan, workouts
  completed, total miles, a miles-per-week chart, and a week-by-week table.
- **Cross-device sync** — changes push automatically and merge by
  most-recent-edit per journal entry (deletions propagate too), with offline
  support via a per-user local cache.
- **Backup** — export/import all your data as JSON. Light and dark mode,
  mobile friendly.

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
js/planParser.js   markdown-table & JSON plan parsing (browser + Node)
js/app.js          auth, schedules, journal, rendering, chart, sync
server.js          dependency-free static server + JSON API
plans/             example plan file (the built-in plan's source)
docs/              plan format reference
```

**API:** `POST /api/register|login|logout`, `GET /api/me`, and
`GET|PUT /api/data` (the signed-in user's state blob). Sessions are HttpOnly
`SameSite=Lax` cookies (90-day expiry); passwords are scrypt-hashed with
per-user salts; auth endpoints are rate-limited. Each user's data is a JSON
file under `DATA_DIR` — no database to manage.

**Sync model:** the client caches state per user in `localStorage` (offline
works), pulls on load/focus, and pushes ~1.5 s after every change. Merging is
last-write-wins per item (plans, schedules, and individual journal entries each
carry `updatedAt`); deletions are tombstones so they win merges and propagate
to other devices.

**Limitations to know about:** there's no password-reset flow (the server
never learns usable emails for sending mail) — resetting a forgotten password
currently means an admin editing the data directory. Fine for a small group of
training partners; add a mail provider if you outgrow it.
