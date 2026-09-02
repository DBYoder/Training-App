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

/* ---- duration entry (phone keypads have no colon) ---- */
const { parseDuration, normalizeDuration } = PaceEngine;
const dur = (input, expected, why) => {
  const got = parseDuration(input);
  const ok = got === expected;
  console.log((ok ? "PASS" : "FAIL"), `duration ${JSON.stringify(input)} -> ${got} (${why})`);
  if (!ok) failed++;
};

dur("45:30", 2730, "colons still work");
dur("1:22:00", 4920, "h:mm:ss");
dur("0:45", 45, "under a minute");
dur("45", 2700, "1-2 digits stay whole minutes");
dur("90", 5400, "90 minutes");
dur("4530", 2730, "digits only, as typed on a numeric keypad");
dur("930", 570, "9:30");
dur("12200", 4920, "1:22:00 without colons");
dur("102030", 37230, "10:20:30");
dur("45:99", null, "impossible seconds rejected");
dur("4599", null, "impossible seconds rejected without colons");
dur("9999999", null, "absurdly long rejected, not silently accepted");
dur("4530x", null, "junk rejected");
dur("", null, "empty");
dur("abc", null, "letters");

// the old behaviour turned "4530" into 4530 MINUTES: a plausible-looking
// 75-hour run that would corrupt pace and weekly mileage
const wrongOld = 4530 * 60;
if (parseDuration("4530") === wrongOld) {
  console.log("FAIL duration '4530' regressed to minutes"); failed++;
} else {
  console.log("PASS duration '4530' is no longer read as 4530 minutes");
}

const norm = (input, expected) => {
  const got = normalizeDuration(input);
  const ok = got === expected;
  console.log((ok ? "PASS" : "FAIL"), `normalize ${JSON.stringify(input)} -> ${got}`);
  if (!ok) failed++;
};
norm("4530", "45:30");
norm("12200", "1:22:00");
norm("45", "45:00");
norm("nonsense", null);

process.exit(failed ? 1 : 0);
