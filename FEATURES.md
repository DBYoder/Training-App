# Feature roadmap

Gaps found by running a full dogfood session (7 weeks into the SWAP plan,
marathon 34 days out), ordered by how hard they bite during real training.

## Tier 1 — changes daily use

| # | Feature | Status |
|---|---------|--------|
| 1 | **Target pace zones** — enter a recent race result; the app computes VDOT (Daniels/Gilbert model) and shows personal paces (easy range, M, T/1-hour, 10k, 5k, 3k) inline on every workout that names an effort. Goal time gets a reality check against current fitness instead of silently inflating zones. | ✅ built |
| 2 | **Quick-log + yesterday** — one-tap "✓ done" on day cards, and an unlogged-yesterday card on the Today tab so back-filling doesn't require the Schedule tab. | ✅ built |
| 3 | **Day swapping** — swap a workout with another day in the same week ("it rained, long run moves to Sunday") without editing the plan. | next up |

## Tier 2 — deepens the payoff

| # | Feature | Status |
|---|---------|--------|
| 4 | **Planned vs. actual mileage** — parse the plan's mileage ranges ("8–12 mi") and draw the planned band behind the actual bars; stop counting rest days in "days logged". | planned |
| 5 | **Pace trends** — average easy pace by week, long-run progression, RPE vs. pace; the journal already collects everything needed. | planned |
| 6 | **Calendar (ICS) export** — subscribe to the schedule from Google/Apple Calendar; dependency-free. | planned |

## Tier 3 — bigger bets

| # | Feature | Status |
|---|---------|--------|
| 7 | Shoe tracking with cumulative mileage | idea |
| 8 | Race-week checklist (fueling notes + goal-pace band splits) | idea |
| 9 | PWA manifest (home-screen install) | idea |
| 10 | GPX/Strava import so logging becomes confirmation, not data entry | idea |
| 11 | Password reset via a mail provider | idea |

## Pace-zone accuracy notes (feature 1)

- Model: Daniels/Gilbert VDOT — published equations, not heuristics.
  - `VO2(v) = -4.60 + 0.182258·v + 0.000104·v²` (v in m/min)
  - `%VO2max(t) = 0.8 + 0.1894393·e^(−0.012778·t) + 0.2989558·e^(−0.1932605·t)` (t in min)
  - VDOT = VO2 at race velocity ÷ %VO2max at race duration.
- Zones from their definitions: easy = 62–74 %VDOT (a range, honestly wide);
  M/10k/5k/3k = equivalent-race paces solved numerically; threshold = the
  pace of a 60-minute race (`%VO2max(60) ≈ 88.8 %VDOT`), which is exactly the
  plan's "1-hour effort".
- Implementation is unit-tested against known VDOT anchors (19:57 5k ⇒ VDOT
  ≈ 50 ⇒ marathon ≈ 3:10:49, 10k ≈ 41:21) and round-trip consistency across
  VDOT 30–65 and all distances.
- Zones derive only from the entered race result. A goal time is compared
  against the equivalent marathon prediction and flagged when it outruns
  current fitness. Fresher input (like the plan's week-9 predictor tempo)
  beats an old PR.
