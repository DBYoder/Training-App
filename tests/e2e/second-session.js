const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib.js");

const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "e2e-shots-"));
const SWAP_MD = L.SWAP_MD;

/* ~6.22 mi over 50 minutes (same generator as the GPX suite). */
function makeGpx(startIso) {
  const start = new Date(startIso).getTime();
  const pts = [];
  for (let k = 0; k <= 90; k++) {
    const lat = (40 + k * 0.001).toFixed(6);
    const t = new Date(start + k * (50 * 60 * 1000) / 90).toISOString();
    pts.push(`<trkpt lat="${lat}" lon="-105.000000"><time>${t}</time></trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1" creator="test"><trk><trkseg>${pts.join("")}</trkseg></trk></gpx>`;
}

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4603 });
  const BASE = server.base;
  const browser = await L.launch();
  try {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 1200 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|409)/.test(m.text())) errors.push("console: " + m.text());
  });
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const race = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 32);
  while (race.getDay() !== 0) race.setDate(race.getDate() + 1);

  const openRow = async (pg, idx) => {
    await pg.click('#tabs button[data-tab="schedule"]');
    await pg.waitForSelector(".week-block");
    if ((await pg.getAttribute("#week-9", "open")) === null) await pg.click("#week-9 summary");
    await pg.click(`.sched-row[data-day="${idx}"]`);
    await pg.waitForSelector("#day-modal[open] #second-block");
  };

  await page.goto(BASE);
  await page.click("#auth-switch-link");
  await page.fill('#auth-form input[name="email"]', "double@example.com");
  await page.fill('#auth-form input[name="password"]', "password123");
  await page.click("#auth-submit");
  await page.waitForSelector(".schedule-form");
  await page.setInputFiles(".schedule-form .form-plan-file", SWAP_MD);
  await page.waitForFunction(() => document.querySelector(".form-upload-msg")?.textContent.includes("Added"));
  await page.fill('.schedule-form input[name="anchorDate"]', iso(race));
  await page.click('.schedule-form button[type="submit"]');
  await page.waitForSelector("#tab-today .day-card");

  /* ---- the block auto-opens on a day the plan suggests a double ---- */
  const wedIdx = 8 * 7 + 2; // week 9 Wednesday: "Optional uphill TM or x-train double"
  await openRow(page, wedIdx);
  if ((await page.getAttribute("#second-block", "open")) === null) {
    throw new Error("second-session block should auto-open on a day suggesting a double");
  }
  console.log("second block auto-opens on an 'optional x-train double' day ✓");

  /* ---- log a cross-training session ---- */
  await page.selectOption('#journal-form select[name="secondKind"]', "bike");
  if (!(await page.locator('#journal-form input[name="secondDistance"]').isDisabled())) {
    throw new Error("distance should be disabled for cross-training (time-only)");
  }
  const xtPlaceholder = await page.getAttribute('#journal-form input[name="secondDistance"]', "placeholder");
  if (!/time only/i.test(xtPlaceholder)) throw new Error("placeholder not updated: " + xtPlaceholder);
  console.log("x-train: distance disabled, tracked by time only ✓");
  await page.fill('#journal-form input[name="secondDuration"]', "45:00");
  await page.fill('#journal-form input[name="secondNotes"]', "Z2 spin, easy legs");
  await page.selectOption('#journal-form select[name="status"]', "completed");
  await page.fill('#journal-form input[name="distance"]', "10");
  await page.fill('#journal-form input[name="duration"]', "1:20:00");
  await page.screenshot({ path: SHOTS + "/s1-second.png" });
  await page.click('#journal-form button[type="submit"]');
  await page.waitForSelector("#save-confirm:not([hidden])");
  await page.click("#modal-close");

  /* ---- reopen: values round-trip ---- */
  await openRow(page, wedIdx);
  const kind = await page.inputValue('#journal-form select[name="secondKind"]');
  const dur = await page.inputValue('#journal-form input[name="secondDuration"]');
  const notes = await page.inputValue('#journal-form input[name="secondNotes"]');
  if (kind !== "bike" || dur !== "45:00" || !notes.includes("Z2 spin")) {
    throw new Error(`second session did not round-trip: ${kind}/${dur}/${notes}`);
  }
  if (!(await page.locator('#journal-form input[name="secondDistance"]').isDisabled())) {
    throw new Error("distance should stay disabled for a saved bike session");
  }
  await page.selectOption('#journal-form select[name="secondKind"]', "double");
  if (await page.locator('#journal-form input[name="secondDistance"]').isDisabled()) {
    throw new Error("distance should re-enable for a running double");
  }
  await page.selectOption('#journal-form select[name="secondKind"]', "bike");
  console.log("cross-training session round-trips (bike · 45:00 · notes); distance toggles by kind ✓");
  await page.click("#modal-close");

  /* ---- a running double via GPX, on a different day ---- */
  const gpxPath = SHOTS + "/second-run.gpx";
  const stamp = new Date(); stamp.setHours(18, 0, 0, 0);
  fs.writeFileSync(gpxPath, makeGpx(stamp.toISOString()));
  const thuIdx = 8 * 7 + 3;
  await openRow(page, thuIdx);
  await page.setInputFiles("#day-modal .gpx-file-second", gpxPath);
  await page.waitForFunction(() => document.querySelector(".gpx-msg-second")?.textContent.includes("imported"));
  const d2 = await page.inputValue('#journal-form input[name="secondDistance"]');
  const k2 = await page.inputValue('#journal-form select[name="secondKind"]');
  const pace2 = await page.textContent("#second-pace-line");
  if (Math.abs(parseFloat(d2) - 6.2) > 0.1) throw new Error("second distance wrong: " + d2);
  if (k2 !== "double") throw new Error("kind not defaulted to double: " + k2);
  if (!pace2.includes("8:0")) throw new Error("second pace wrong: " + pace2);
  console.log(`GPX into second session: ${d2} mi · ${pace2.trim()} · kind=${k2} ✓`);
  await page.selectOption('#journal-form select[name="status"]', "completed");
  await page.fill('#journal-form input[name="distance"]', "8");
  await page.click('#journal-form button[type="submit"]');
  await page.waitForSelector("#save-confirm:not([hidden])");
  await page.click("#modal-close");

  /* ---- chip renders on the day card ---- */
  await page.click('#tabs button[data-tab="today"]');
  await page.waitForSelector("#tab-today .day-card");
  await page.click("#tab-today .day-card");
  await page.waitForSelector("#day-modal[open] #second-block");
  if ((await page.getAttribute("#second-block", "open")) === null) await page.click("#second-block summary");
  await page.selectOption('#journal-form select[name="secondKind"]', "strength");
  await page.fill('#journal-form input[name="secondDuration"]', "30:00");
  await page.click('#journal-form button[type="submit"]');
  await page.waitForSelector("#save-confirm:not([hidden])");
  await page.click("#modal-close");
  await page.waitForSelector("#tab-today .second-chip");
  const chipText = await page.textContent("#tab-today .second-chip");
  if (!/strength/i.test(chipText)) throw new Error("chip text wrong: " + chipText);
  console.log("day card shows second-session chip:", chipText.trim(), "✓");

  /* ---- progress: double adds miles + a run, x-train counted separately ---- */
  await page.click('#tabs button[data-tab="progress"]');
  await page.waitForSelector(".week-table tbody tr");
  const cells = await page.locator(".week-table tbody tr").nth(8).locator("td").allTextContents();
  const [, , , milesCell, runsCell, xtrainCell] = cells.map((c) => c.trim());
  // 10 (wed) + 8 (thu) + 6.2 (double) = 24.2 mi; 3 runs; 1 x-train (the bike)
  if (milesCell !== "24.2") throw new Error("double miles not added: " + cells.join(" | "));
  if (runsCell !== "3") throw new Error("double not counted as a run: " + cells.join(" | "));
  // the bike session was 45:00 and must be reported as TIME, never miles
  if (xtrainCell !== "0:45") throw new Error("x-train should report time (0:45): " + cells.join(" | "));
  console.log(`week 9: ${milesCell} mi · ${runsCell} runs · ${xtrainCell} x-train time ✓`);
  const tiles = (await page.locator(".stat-tile").allTextContents()).join(" | ");
  if (!/x-train/i.test(tiles)) throw new Error("x-train stat tile missing: " + tiles);
  // 45:00 bike + 30:00 strength logged on today's card = 1:15 total
  if (!/1:15/.test(tiles)) throw new Error("x-train tile should total time (1:15): " + tiles);
  console.log("x-train stat tile totals time (1:15) ✓");
  await page.screenshot({ path: SHOTS + "/s2-progress.png" });

  /* ---- regression: quick-log and entry deletion still work ---- */
  await page.click('#tabs button[data-tab="today"]');
  await page.waitForSelector("#tab-today .day-card");
  const quickBefore = await page.locator("#tab-today .quick-log").count();
  if (quickBefore) {
    await page.locator("#tab-today .quick-log").first().click();
    await page.waitForFunction(() =>
      document.querySelectorAll("#tab-today .status-badge").length > 0);
    console.log("regression: quick-log still marks a day complete ✓");
  } else {
    console.log("regression: quick-log n/a (all visible days already logged)");
  }
  await page.click("#tab-today .day-card");
  await page.waitForSelector("#day-modal[open]");
  page.once("dialog", (d) => d.accept());
  await page.click("#clear-entry");
  await page.waitForFunction(() => !document.querySelector("#day-modal").open);
  console.log("regression: delete entry still works ✓");

  /* ---- syncs to a second device ---- */
  await page.waitForTimeout(2200);
  const p2 = await (await browser.newContext()).newPage();
  await p2.goto(BASE);
  await p2.fill('#auth-form input[name="email"]', "double@example.com");
  await p2.fill('#auth-form input[name="password"]', "password123");
  await p2.click("#auth-submit");
  await p2.waitForSelector("#tab-today .day-card");
  await openRow(p2, wedIdx);
  if ((await p2.inputValue('#journal-form select[name="secondKind"]')) !== "bike") {
    throw new Error("second session did not sync");
  }
  console.log("second session synced to another device ✓");

  if (errors.length) throw new Error("Browser errors:\n" + errors.join("\n"));
  console.log("\nALL SECOND-SESSION E2E CHECKS PASSED");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
