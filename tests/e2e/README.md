# End-to-end tests

Browser tests driven by Playwright against a locally-running server.

```bash
npm install --no-save playwright-core        # once
DATA_DIR=/tmp/e2e-data PORT=4582 node server.js &
node tests/e2e/second-session.js
```

If `playwright-core` is installed outside the repo, point Node at it:
`NODE_PATH=/path/to/node_modules node tests/e2e/second-session.js`.

Each suite registers its own account against a throwaway `DATA_DIR`, so run
one server per suite and delete the data directory between runs.

Run suites **sequentially** — several headless Chromium instances competing
for CPU produce spurious timeouts.
