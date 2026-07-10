# Marathon Training Tracker 🏃

A web app for the **SWAP 12-Week Advanced Marathon Plan**. Enter your marathon
date and the app back-schedules all 84 days of training to end on race day —
then shows you what to run each day and lets you journal how it went so you can
track progress toward your goal.

## Features

- **Back-scheduled plan** — pick your race date and every workout gets a real
  calendar date, ending on race day. The plan is written for a Sunday race, but
  any date works; the whole schedule just shifts.
- **Today view** — today's workout front and center, plus what's up next and a
  live countdown to race day.
- **Full schedule** — all 12 weeks, expandable by week, with the current week
  highlighted and each day color-tagged (rest / easy / workout / long run / race).
- **Training journal** — for every day, log how it went (completed / modified /
  skipped), distance, total time (average pace is computed for you), effort
  (RPE 1–10), a 1–5 star feel rating, and free-form notes for splits, weather,
  fueling, etc.
- **Progress tracking** — days-to-race, percent through the plan, workouts
  completed, total miles, a miles-per-week chart, and a week-by-week table.
- **Cross-device sync** — turn on sync in Settings to get a private sync code,
  then enter that code on your phone/other computer (Settings, or "restore" on
  the start screen) to keep race date and journal in sync everywhere.
- **Backup** — export/import your journal as JSON from the Settings tab.
- Light and dark mode, mobile friendly.

## Running it

The app itself is fully static — no build step, no dependencies. A tiny
dependency-free Node server (`server.js`) is included for hosting.

- **Locally:** run `npm start` and visit `http://localhost:3000`, or just open
  `index.html` directly in a browser.
- **Railway:** create a new Railway project from this GitHub repo — Railway
  detects the Node app automatically, runs `npm start`, and the server binds to
  Railway's `PORT`. Then open **Settings → Networking → Generate Domain** on the
  service to get your public URL.
  - **For sync to survive redeploys, attach a volume:** on the service, add a
    volume with mount path `/app/data` (the server's default data directory).
    Alternatively mount it anywhere and set the `DATA_DIR` environment variable
    to that path. Without a volume the app still works, but synced data is
    reset on each deploy.
- **GitHub Pages (alternative):** enable Pages for this branch/root in the repo
  settings; the app works as a plain static site too (without cross-device sync,
  which needs the server).

## Where your data lives

Everything (race date + journal) is stored in your browser's `localStorage` and
works fully offline. Journal entries are keyed to plan days (e.g. "Week 5,
Wednesday workout"), so changing the race date later shifts the calendar
without losing any entries.

With **cross-device sync** turned on, the app also mirrors your data to the
server under your sync code. The code is never stored on the server — data
lives under its SHA-256 hash, so the code works like a password: anyone who has
it can read and change that training log. Use the generated codes (or something
equally strong) and keep them private. Syncing merges by most-recent-edit per
journal entry, and deletions propagate too, so devices converge even after
offline edits.

**Settings → Export** still gives you a JSON backup at any time.

## Project layout

```
index.html      app shell
css/styles.css  styles (light + dark)
js/plan.js      the 12-week plan as structured data (84 days)
js/app.js       scheduling, journal, rendering, chart
server.js       dependency-free static server for hosting (Railway etc.)
package.json    start script + Node version for Railway's auto-detection
```

## The plan

The SWAP 12-Week Advanced Marathon Plan's distance ranges create multiple plans
in one: the low end of each range is for intermediate runners, the high end for
advanced athletes with a big base.
