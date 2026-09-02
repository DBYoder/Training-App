/* Calendar maths: Monday-aligned weeks, race-day truncation, start-date
 * snapping, day swaps, and the plan importers (markdown + PDF). */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib.js");

/* Render the markdown plan as a grid PDF, the way a coach would hand one out. */
async function makePlanPdf(browser) {
  const md = fs.readFileSync(L.SWAP_MD, "utf8");
  const lines = md.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const cells = (l) => l.split("|").slice(1, -1).map((c) =>
    c.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\\([!*_#[\]()`])/g, "$1").trim());
  const header = cells(lines[0]);
  const rows = lines.slice(1).map(cells).filter((r) => !r.every((c) => /^:?-+:?$/.test(c) || c === ""));
  const html = `<!DOCTYPE html><meta charset="utf-8"><style>
    body{font-family:Arial;font-size:6.5px} h1{font-size:13px}
    table{border-collapse:collapse;width:100%;table-layout:fixed}
    th,td{border:1px solid #999;padding:3px;vertical-align:top;text-align:left}
    th:first-child,td:first-child{width:34px;font-weight:bold}</style>
    <h1>SWAP 12-Week Advanced Marathon Plan</h1><table>
    <tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-pdf-"));
  const htmlPath = path.join(dir, "plan.html");
  const pdfPath = path.join(dir, "plan.pdf");
  fs.writeFileSync(htmlPath, html);
  const page = await (await browser.newContext()).newPage();
  await page.goto("file://" + htmlPath);
  await page.pdf({ path: pdfPath, format: "Letter", landscape: true,
    margin: { top: "0.4in", bottom: "0.4in", left: "0.4in", right: "0.4in" } });
  await page.close();
  return pdfPath;
}

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4602 });
  const browser = await L.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
    errors.push(...L.trackErrors(page, "sched"));

    /* ---- race mode on a WEDNESDAY ---- */
    const raceWed = L.upcoming(3, 35);
    await L.register(page, server.base, "sched@example.com");
    await L.createSchedule(page, { anchor: raceWed });

    await page.click('#tabs button[data-tab="schedule"]');
    await page.waitForSelector(".week-block");
    L.check("week 1 starts on a Monday",
      (await page.textContent('.sched-row[data-day="0"] .sched-date')).trim().startsWith("Mon"));
    L.check("12 week blocks render",
      (await page.locator(".week-block").count()) === 12);
    L.check("a mid-week race truncates the final week (80 days, not 84)",
      (await page.locator(".sched-row").count()) === 80,
      `got ${await page.locator(".sched-row").count()}`);

    if ((await page.getAttribute("#week-12", "open")) === null) await page.click("#week-12 summary");
    const lastRow = await page.textContent('.sched-row[data-day="79"]');
    L.check("race day lands on its true Wednesday date",
      /marathon/i.test(lastRow) && lastRow.includes("Wed"), lastRow.replace(/\s+/g, " ").trim());

    /* ---- day swap within a week ---- */
    const wed = 8 * 7 + 2, thu = 8 * 7 + 3;
    if ((await page.getAttribute("#week-9", "open")) === null) await page.click("#week-9 summary");
    const wedBefore = (await page.textContent(`.sched-row[data-day="${wed}"] .sched-title`)).trim();
    const thuBefore = (await page.textContent(`.sched-row[data-day="${thu}"] .sched-title`)).trim();
    await L.openDay(page, 9, wed);
    await page.selectOption("#swap-target", String(thu));
    await page.click("#swap-btn");
    await page.waitForFunction(() => !document.querySelector("#day-modal").open);
    if ((await page.getAttribute("#week-9", "open")) === null) await page.click("#week-9 summary");
    L.check("swapping exchanges the two days' workouts",
      (await page.textContent(`.sched-row[data-day="${wed}"] .sched-title`)).trim() === thuBefore &&
      (await page.textContent(`.sched-row[data-day="${thu}"] .sched-title`)).trim() === wedBefore);

    await L.openDay(page, 9, wed);
    L.check("a swapped day is tagged in the modal",
      (await page.locator("#day-modal .swap-tag").count()) === 1);
    await page.click("#swap-undo");
    await page.waitForFunction(() => !document.querySelector("#day-modal").open);
    if ((await page.getAttribute("#week-9", "open")) === null) await page.click("#week-9 summary");
    L.check("undo restores the original order",
      (await page.textContent(`.sched-row[data-day="${wed}"] .sched-title`)).trim() === wedBefore);

    /* ---- start mode snaps forward to Monday ---- */
    await page.click('#tabs button[data-tab="settings"]');
    await page.click("#new-schedule-details summary");
    await page.check('.schedule-form input[value="start"]');
    const today = new Date();
    await page.fill('.schedule-form input[name="anchorDate"]', L.iso(today));
    const preview = await page.textContent(".anchor-preview");
    L.check("the form previews the resolved span",
      preview.includes("12 weeks") && (today.getDay() === 1 || preview.includes("snaps")),
      preview.trim());
    await page.click('.schedule-form button[type="submit"]');
    await page.waitForSelector("#tab-today .notice, #tab-today .day-card");
    const expectedMonday = new Date(today);
    while (expectedMonday.getDay() !== 1) expectedMonday.setDate(expectedMonday.getDate() + 1);
    const todayText = await page.textContent("#tab-today");
    const longFmt = new Intl.DateTimeFormat("en-US",
      { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(expectedMonday);
    const medFmt = new Intl.DateTimeFormat("en-US",
      { weekday: "short", month: "short", day: "numeric" }).format(expectedMonday);
    L.check("start mode begins on the next Monday",
      todayText.includes(longFmt) || (todayText.includes(medFmt) && todayText.includes("Day 1 of 84")));

    /* ---- PDF import ---- */
    const pdf = await makePlanPdf(browser);
    await page.click('#tabs button[data-tab="plans"]');
    await page.waitForSelector("#plan-file", { state: "attached" });
    await page.setInputFiles("#plan-file", pdf);
    await page.waitForFunction(
      () => document.querySelector("#plan-upload-msg")?.textContent.includes("Added"),
      null, { timeout: 45000 });
    const libRows = await page.locator("#tab-plans .plan-list:not(#shares-list) .plan-row").allTextContents();
    L.check("a grid-style PDF imports as 12 weeks / 84 days",
      libRows.some((r) => r.includes("12 weeks · 84 days")) && libRows.length === 2,
      libRows.join(" | "));

    const badPdf = path.join(os.tmpdir(), `bad-${Date.now()}.pdf`);
    fs.writeFileSync(badPdf, "%PDF-1.4 not really a pdf");
    await page.setInputFiles("#plan-file", badPdf);
    await page.waitForFunction(() => {
      const el = document.querySelector("#plan-upload-msg");
      return el && el.textContent.trim() && !el.textContent.includes("Reading");
    }, null, { timeout: 45000 }).catch(() => {});
    const badMsg = (await page.textContent("#plan-upload-msg")).trim();
    const isErr = await page.evaluate(() =>
      document.querySelector("#plan-upload-msg").classList.contains("sync-error"));
    L.check("a corrupt PDF is refused with a message", isErr,
      `class=${isErr} msg=${JSON.stringify(badMsg)}`);

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nSCHEDULING + IMPORT: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
