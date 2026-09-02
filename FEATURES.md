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
| 12 | **Accessibility beyond contrast** | Contrast and sizing are done; keyboard focus order, visible focus rings, screen-reader labels and `prefers-reduced-motion` (the design leans on glow and transitions) are not. | M |
| 13 | **Plan-import robustness** | Scanned/photo PDFs fail (needs OCR); day-type classification is heuristic and disagreed with hand-tagging on 2 of 84 days. Let users correct a day's type in the builder instead of chasing parser accuracy. | S |

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

P0 and P1 are complete (#8, sync conflicts, shipped: each device remembers
the state at its last sync, so a merge can tell a real conflict from a
one-sided change, and the replaced edit is shown with a one-click restore).

P2 continues with accessibility beyond contrast (#12) and plan-import
robustness (#13). #11 Strava still waits on you registering an API app.

To switch email from "logged to the console" to real delivery, set
`MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL` on the
Railway service — no code change needed.
