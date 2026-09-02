# Roadmap

## Shipped

**Tier 1 — daily use**
- Target pace zones (Daniels VDOT, validated against published tables)
- Quick-log "✓ done" and an unlogged-yesterday card
- Day swapping within a week, with undo

**Tier 2 — depth**
- Planned-vs-actual mileage band; rest days excluded from "days logged"
- Average-pace-per-week trend
- Calendar (ICS) export

**Tier 3 — selected**
- Installable PWA with an offline shell
- GPX import (watch / Strava "Export GPX"), main and second session
- Optional second session per day (double / x-train / strength), with
  cross-training measured in time rather than miles
- Mobile legibility pass: WCAG AA across every screen, 1:1 chart labels
- Keyboard and screen-reader pass: focus rings, tablist semantics, live
  status announcements, `prefers-reduced-motion`
- Per-day type override in the plan builder, so a misread day is a dropdown
  away from correct

---

# Prioritized improvements

Ordered by risk × likelihood ÷ effort, not by how interesting they are. The
theme of the top tier is **"safe to hand to other people"** — that is the gap
between this being your training app and being your group's training app.

## P0 — do before more people depend on it

| # | Item | Why now | Effort |
|---|------|---------|--------|
| 1 | ~~**Automated volume backups**~~ | ✅ **Done.** Scheduled on-volume snapshots with rotation, a token-gated `GET /api/admin/backup` for off-box pulls, a nightly GitHub Action keeping 90-day artifacts, and a restore CLI. Verified by restoring a simulated volume wipe. | S |
| 2 | ~~**Password reset**~~ | ✅ **Done.** Single-use, one-hour, hash-stored tokens; neutral responses that never reveal who has an account; completing a reset drops every existing session. Works with Resend, or logs links to the server when no provider is set. | M |
| 3 | ~~**Email verification**~~ | ✅ **Done.** Confirmation on signup, resend from Settings, and unverified accounts cannot receive shared plans — enforced only when mail is actually configured. | S |
| 4 | ~~**Restore the e2e suites + CI**~~ | ✅ **Done.** Rebuilt as `accounts-and-sharing` (isolation, sync, hostile-share sanitisation) and `scheduling` (alignment, truncation, swaps, md/PDF import) on a shared `lib.js` that boots a throwaway server per suite; all four run via `npm run test:e2e`, and GitHub Actions runs unit + browser suites on every push. | M |

## P1 — trust and correctness

| # | Item | Why | Effort |
|---|------|-----|--------|
| 5 | ~~**Security headers**~~ | ✅ **Done.** Strict CSP (no `unsafe-inline`, `frame-ancestors 'none'`), HSTS behind HTTPS, nosniff, frame and referrer policy. Enforcing it surfaced two inline `style` attributes, now moved to CSS. | S |
| 6 | ~~**Account deletion**~~ | ✅ **Done.** Password-confirmed deletion removes the user record, training data, share inbox, index entry, sessions and pending tokens. (Export already existed.) | S |
| 7 | ~~**Rate-limit persistence**~~ | ✅ **Done.** Counters mirror to disk on a 5 s throttle and reload on boot, so a redeploy no longer hands out a fresh budget. Verified by restarting a server mid-suite. | S |

## P2 — the training experience

| # | Item | Why | Effort |
|---|------|-----|--------|
| 9 | ~~**Race-week checklist**~~ | ✅ **Done.** In the last 7 days the Today tab leads with goal-pace splits (5K→finish) from the runner's own VDOT, the plan's own fuelling numbers plus the total they imply for the predicted finish, plus a fuelling plan and checklist the runner owns — both seeded from the plan, then freely editable (carb totals recompute live; "reset to plan" restores the original numbers). An over-ambitious goal is flagged and never drives the splits. | M |
| 10 | ~~**Adherence / streak view**~~ | ✅ **Done.** Progress gains plan-adherence % (completed ÷ scheduled runs elapsed, rest days excluded) and a current/best day streak where rest days carry the streak and an unlogged today never breaks it. | S |
| 11 | **Full Strava integration** | Gated on you registering a Strava API app, and on their athlete-capacity review before partners can connect. GPX import covers the case today. | L |
| 12 | ~~**Accessibility beyond contrast**~~ | ✅ **Done.** A reserved-colour focus ring on every control (glow alone couldn't carry focus — it's the same treatment as hover), tabs/panels wired as a real tablist, accessible names everywhere, one persistent live region so status messages are heard and not just seen, and `prefers-reduced-motion` honoured. Measured by tabbing through a real browser, which found three unlabeled inputs and a focus ring that never rendered. | M |
| 13 | ~~**Plan-import robustness**~~ | ✅ **Done.** Every day in the builder shows the type the parser detected and offers a dropdown to pin a different one. A pin beats detection, survives rewriting the day's text, and round-trips through save/sync/reload; clearing it hands the day back to the classifier. Opening an uploaded or shared plan pins only the days whose stored type disagrees with detection, so saving one unchanged can't silently reclassify it. Scanned/photo PDFs still need OCR and remain out of scope. | S |

## P3 — only if it grows

| # | Item | Trigger |
|---|------|---------|
| 14 | SQLite instead of JSON files | ~100+ users, or when you want real queries/metrics |
| 15 | Postgres + stateless server + replicas | 1,000+ users, or a need for uptime guarantees |
| 16 | Delta sync instead of whole-blob PUT | When state blobs get large enough to feel slow |
| 17 | Split `js/app.js` (2,585 lines) into modules | When more than one person edits it |
| 18 | Shoe mileage tracking | Deferred by owner |

---

## Suggested next move

P0, P1 and P2 are complete except #11. **Strava** is the only P2 item left,
and it needs two things from you before any code helps: register a Strava
API app (client ID + secret), and submit it for their athlete-capacity
review — until that clears, a partner app is capped at a single-digit number
of connected athletes. GPX import covers the case in the meantime.

After that, nothing on this list is worth doing on a schedule. P3 items are
all triggered by growth, not by time: revisit them when the user count or
the size of a state blob actually crosses the trigger in the table.

To switch email from "logged to the console" to real delivery, set
`MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL` on the
Railway service — no code change needed.
