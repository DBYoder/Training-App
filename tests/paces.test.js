/* Validation of the VDOT pace engine against published Daniels anchors.
 * Run: node tests/paces.test.js */
"use strict";
const { PaceEngine } = require("../js/paces.js");
const { vdotFromRace, equivalentRaceTime, trainingPaces } = PaceEngine;

let failed = 0;
const near = (actual, expected, tolPct, label) => {
  const err = Math.abs(actual - expected) / expected * 100;
  const ok = err <= tolPct;
  console.log((ok ? "PASS" : "FAIL"), label, `(${err.toFixed(2)}% off)`);
  if (!ok) failed++;
};

// canonical VDOT-50 anchor row from Daniels' published tables
near(vdotFromRace(5000, 19 * 60 + 57), 50, 1, "19:57 5k => VDOT 50");
near(equivalentRaceTime(50, 42195), 11449, 1, "VDOT 50 marathon 3:10:49");
near(equivalentRaceTime(50, 10000), 2481, 1, "VDOT 50 10k 41:21");
near(equivalentRaceTime(50, 21097.5), 5495, 1, "VDOT 50 half 1:31:35");
near(equivalentRaceTime(60, 5000), 1023, 1, "VDOT 60 5k 17:03");
near(equivalentRaceTime(60, 42195), 9805, 1, "VDOT 60 marathon 2:43:25");
near(equivalentRaceTime(30, 5000), 1840, 1, "VDOT 30 5k 30:40");
near(trainingPaces(50).M, 437, 1, "VDOT 50 M pace 7:17/mi");
near(trainingPaces(50).T, 411, 1, "VDOT 50 T pace 6:51/mi");

// round-trip consistency across the usable band
let worst = 0;
for (let v = 30; v <= 65; v += 5) {
  for (const d of [3000, 5000, 10000, 21097.5, 42195]) {
    worst = Math.max(worst, Math.abs(vdotFromRace(d, equivalentRaceTime(v, d)) - v));
  }
}
console.log(worst < 0.01 ? "PASS" : "FAIL", "round-trip max error " + worst.toExponential(1));
if (worst >= 0.01) failed++;

// zone ordering must be monotonic (3k fastest ... easy slowest)
const z = trainingPaces(50);
const order = [z.threeK, z.fiveK, z.tenK, z.T, z.M, z.easyFast, z.easySlow];
const mono = order.every((x, i) => i === 0 || x > order[i - 1]);
console.log(mono ? "PASS" : "FAIL", "zone ordering monotonic");
if (!mono) failed++;

// garbage in => null out (never silently wrong zones)
if (vdotFromRace(5000, 5 * 60) !== null || vdotFromRace(42195, 20 * 3600) !== null) {
  console.log("FAIL implausible inputs should return null"); failed++;
} else console.log("PASS implausible inputs return null");

/* ---- duration entry: a live hh:mm:ss mask (phone keypads have no colon) ---- */
const { parseDuration, normalizeDuration, maskDuration } = PaceEngine;

const mask = (typed, shown) => {
  const got = maskDuration(typed);
  const ok = got === shown;
  console.log((ok ? "PASS" : "FAIL"), `typing ${JSON.stringify(typed)} shows ${JSON.stringify(got)}`);
  if (!ok) failed++;
};
// the sequence a user sees while typing 012133
mask("0", "0");
mask("01", "01");
mask("012", "0:12");
mask("0121", "01:21");
mask("01213", "0:12:13");
mask("012133", "01:21:33");
mask("4530", "45:30");
mask("1:21:33", "1:21:33");    // re-masking an already-formatted value is stable
mask("0121334", "01:21:33");   // capped at six digits
mask("", "");

const dur = (input, expected, why) => {
  const got = parseDuration(input);
  const ok = got === expected;
  console.log((ok ? "PASS" : "FAIL"), `duration ${JSON.stringify(input)} -> ${got} (${why})`);
  if (!ok) failed++;
};
dur("01:21:33", 4893, "the masked value parses to what it displays");
dur("45:30", 2730, "mm:ss");
dur("1:22:00", 4920, "h:mm:ss");
dur("0:45", 45, "under a minute");
dur("45", 45, "bare digits mean what the mask shows: 45 seconds");
dur("4530", 2730, "digits only, as typed on a numeric keypad");
dur("012133", 4893, "the user's example, unformatted");
dur("45:99", null, "impossible seconds rejected");
dur("99", null, "60+ seconds cannot be a bare value");
dur("9999999", null, "absurdly long rejected, not silently accepted");
dur("4530x", null, "junk is rejected, not silently stripped to 45:30");
dur("", null, "empty");
dur("abc", null, "letters");

// the original bug: a colon-free "4530" was read as 4530 MINUTES — a
// plausible-looking 75-hour run that would corrupt pace and weekly mileage
if (parseDuration("4530") === 4530 * 60) {
  console.log("FAIL duration '4530' regressed to minutes"); failed++;
} else {
  console.log("PASS duration '4530' is no longer read as 4530 minutes");
}

// what the mask displays and what gets parsed must never disagree
for (const digits of ["5", "45", "123", "4530", "01213", "012133", "90000"]) {
  const shown = maskDuration(digits);
  const a = parseDuration(digits), b = parseDuration(shown);
  const ok = a === b;
  console.log((ok ? "PASS" : "FAIL"), `mask and parse agree for ${JSON.stringify(digits)} (${shown})`);
  if (!ok) failed++;
}

const norm = (input, expected) => {
  const got = normalizeDuration(input);
  const ok = got === expected;
  console.log((ok ? "PASS" : "FAIL"), `normalize ${JSON.stringify(input)} -> ${got}`);
  if (!ok) failed++;
};
norm("4530", "45:30");
norm("012133", "1:21:33");
norm("45", "0:45");
norm("nonsense", null);

process.exit(failed ? 1 : 0);
