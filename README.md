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
- **Backup** — export/import your journal as JSON from the Settings tab.
- Light and dark mode, mobile friendly.

## Running it

It's a fully static site — no build step, no server, no dependencies.

- **Locally:** open `index.html` in a browser, or serve the folder with
  `python3 -m http.server` and visit `http://localhost:8000`.
- **GitHub Pages:** in the repo settings, enable Pages for this branch/root and
  the app is live at your Pages URL.

## Where your data lives

Everything (race date + journal) is stored in your browser's `localStorage` —
nothing leaves your device. Use **Settings → Export** to back it up or move it
to another device. Journal entries are keyed to plan days (e.g. "Week 5,
Wednesday workout"), so changing the race date later shifts the calendar
without losing any entries.

## Project layout

```
index.html      app shell
css/styles.css  styles (light + dark)
js/plan.js      the 12-week plan as structured data (84 days)
js/app.js       scheduling, journal, rendering, chart
```

## The plan

The SWAP 12-Week Advanced Marathon Plan's distance ranges create multiple plans
in one: the low end of each range is for intermediate runners, the high end for
advanced athletes with a big base.
