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
| 5 | **Security headers** | No CSP, HSTS, `X-Content-Type-Options` or frame protection. The app renders user-authored plan text and accepts shared plans; CSP is the backstop if a sanitisation bug ever slips through. | S |
| 6 | **Account deletion & data export** | No way for a user to remove their account. Export exists per-user; deletion doesn't. Basic obligation once other people have accounts. | S |
| 7 | **Rate-limit persistence** | Auth throttling lives in memory and resets on every deploy/restart — trivially defeated on a platform that restarts often. Move the counter to disk alongside sessions. | S |
| 8 | **Sync conflict visibility** | Merges are silent last-write-wins per entry. Two devices editing the same day means one edit vanishes with no notice. At minimum, detect and tell the user; ideally keep the loser in the notes. | M |

## P2 — the training experience

| # | Item | Why | Effort |
|---|------|-----|--------|
| 9 | **Race-week checklist** | The last unbuilt item from the dogfood session: surface the plan's own fueling guidance ("75–90 g carbs/hr") plus goal-pace splits as a checklist in the final week, when it actually matters. | M |
| 10 | **Adherence / streak view** | Journals hold the data; nothing summarises "how faithfully am I hitting the plan?" over time. A simple completion-rate trend answers the question people actually ask at week 8. | S |
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

P0 is complete. P1 is next: security headers (#5), account deletion (#6),
persistent rate limits (#7), and visible sync conflicts (#8).

To switch email from "logged to the console" to real delivery, set
`MAIL_PROVIDER=resend`, `RESEND_API_KEY`, `MAIL_FROM` and `APP_URL` on the
Railway service — no code change needed.
