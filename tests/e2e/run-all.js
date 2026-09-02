/* Runs every browser suite sequentially, each on its own port and data dir.
 *
 * Sequential on purpose: several headless Chromium instances competing for
 * CPU produce spurious timeouts that look like product bugs.
 *
 *   npm install --no-save playwright-core
 *   node tests/e2e/run-all.js
 */
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const SUITES = [
  ["accounts-and-sharing.js", 4601],
  ["auth-recovery.js", 4605],
  ["scheduling.js", 4602],
  ["second-session.js", 4603],
  ["mobile-a11y.js", 4604],
  ["hardening.js", 4606],
];

let failed = [];
for (const [file, port] of SUITES) {
  console.log(`\n=== ${file} (port ${port}) ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), BASE: `http://localhost:${port}` },
  });
  if (res.status !== 0) failed.push(file);
}

console.log("");
if (failed.length) {
  console.error(`FAILED: ${failed.join(", ")}`);
  process.exit(1);
}
console.log(`All ${SUITES.length} browser suites passed.`);
