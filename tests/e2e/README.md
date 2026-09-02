# End-to-end tests

Browser suites driven by Playwright. Each suite starts its own server on its
own port against a throwaway `DATA_DIR`, so they need no setup and share no
state.

```bash
npm install --no-save playwright-core
npm run test:e2e            # all suites, sequentially
node tests/e2e/scheduling.js   # or one at a time
```

| Suite | Guards |
|---|---|
| `accounts-and-sharing.js` | account isolation, wrong-password/duplicate-email handling, cross-device sync, unauthenticated API access, and sanitisation of a hostile shared plan planted straight at the API |
| `scheduling.js` | Monday alignment, mid-week race truncation, start-date snapping, day swap + undo, markdown and PDF import |
| `second-session.js` | optional double / cross-training logging, GPX into a second session, time-based x-train accounting, sync |
| `mobile-a11y.js` | every rendered text node against its WCAG AA threshold on a phone viewport, plus the 16px input floor that stops iOS zooming |

Run them **sequentially** (what `run-all.js` does): several headless Chromium
instances competing for CPU produce spurious timeouts that look like product
bugs.

If `playwright-core` lives outside the repo, point Node at it with
`NODE_PATH=/path/to/node_modules`. `CHROMIUM_PATH` overrides the browser
binary (defaults to `/opt/pw-browsers/chromium`).
