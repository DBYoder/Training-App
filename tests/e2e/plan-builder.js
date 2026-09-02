/* The in-app plan builder, and the day-type override that lets a runner
 * correct the classifier when it guesses wrong.
 *
 * Day-type detection is a heuristic over free text; it will always be wrong
 * on some plans. What has to hold is that a runner can fix it, and that the
 * fix survives editing the text and reloading.
 */
"use strict";

const L = require("./lib.js");

const cell = (w, d) => `.builder-week:nth-of-type(${w + 1}) textarea[data-w="${w}"][data-d="${d}"]`;
const typeSel = (w, d) => `.builder-type[data-w="${w}"][data-d="${d}"]`;

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4610 });
  const browser = await L.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 1100 } })).newPage();
    errors.push(...L.trackErrors(page, "builder"));

    await L.register(page, server.base, "builder@example.com");

    /* ---------- build a plan from scratch ---------- */
    await page.click(".schedule-form .form-build-plan");
    await page.waitForSelector("#builder-name");
    await page.fill("#builder-name", "Override Test Block");

    await page.fill(cell(0, 0), "Rest");
    await page.fill(cell(0, 1), "6 mi easy");
    await page.fill(cell(0, 2), "6 x 800 at 10k effort");
    await page.fill(cell(0, 3), "Recovery spin, 40 min");   // no running words at all
    await page.fill(cell(0, 4), "5 mi easy");
    await page.fill(cell(0, 5), "Long run: 14 mi");
    await page.fill(cell(0, 6), "");

    /* the detected type is shown, so a wrong guess is visible before saving */
    const auto = async (d) => (await page.locator(`${typeSel(0, d)} option`).first().textContent()).trim();
    L.check("each day shows the type the parser detected",
      (await auto(0)) === "auto: Rest" &&
      (await auto(1)) === "auto: Easy" &&
      (await auto(2)) === "auto: Workout" &&
      (await auto(5)) === "auto: Long run",
      [await auto(0), await auto(1), await auto(2), await auto(5)].join(" | "));

    L.check("a blank day reads as rest", (await auto(6)) === "auto: Rest", await auto(6));

    /* the classifier calls the cross-training day an easy run — that is the
       kind of miss the override exists for */
    L.check("the detected type updates as the text is edited",
      (await auto(3)) === "auto: Easy", await auto(3));

    await page.selectOption(typeSel(0, 3), "rest");
    L.check("a pinned type is styled as deliberate, not as the default",
      await page.locator(typeSel(0, 3)).evaluate((el) => el.classList.contains("is-pinned")));

    await page.click("#builder-save");
    await page.waitForSelector(".plan-row");
    L.check("the built plan lands in the library",
      (await page.textContent(".plan-row")).includes("Override Test Block"),
      await page.textContent(".plan-row"));

    /* ---------- the override is what the schedule uses ---------- */
    await page.click(".plan-row .use-plan");
    await page.waitForSelector(".schedule-form");
    // a Sunday race, so the single week isn't truncated at the race date
    const race = L.upcoming(0, 40);
    await page.fill('.schedule-form input[name="anchorDate"]',
      `${race.getFullYear()}-${String(race.getMonth() + 1).padStart(2, "0")}-${String(race.getDate()).padStart(2, "0")}`);
    await page.click('.schedule-form button[type="submit"]');
    await page.waitForSelector("#tab-today .day-card, #tab-today .notice");

    await page.click('#tabs button[data-tab="schedule"]');
    await page.waitForSelector(".week-block");
    if ((await page.getAttribute("#week-1", "open")) === null) {
      await page.click("#week-1 summary");
    }
    const rowType = (d) => page.locator(`.sched-row[data-day="${d}"] .type-tag`).textContent();
    L.check("the pinned day is scheduled as the type the runner chose",
      (await rowType(3)) === "Rest", await rowType(3));
    L.check("days left on auto keep their detected types",
      (await rowType(2)) === "Workout" && (await rowType(5)) === "Long run",
      `${await rowType(2)} / ${await rowType(5)}`);

    /* ---------- the pin survives editing the text and a reload ---------- */
    await page.click('#tabs button[data-tab="plans"]');
    await page.waitForSelector(".plan-row .edit-plan");
    await page.click(".plan-row .edit-plan");
    await page.waitForSelector("#builder-name");
    L.check("re-opening the plan shows the pin still set",
      (await page.inputValue(typeSel(0, 3))) === "rest",
      await page.inputValue(typeSel(0, 3)));
    L.check("days left on auto come back on auto",
      (await page.inputValue(typeSel(0, 2))) === "",
      await page.inputValue(typeSel(0, 2)));

    // rewriting the text must not silently un-pin the type
    await page.fill(cell(0, 3), "Recovery spin, 60 min on the bike");
    L.check("the auto label follows the new text",
      (await auto(3)) === "auto: Easy", await auto(3));
    L.check("but the pin is still the selected value",
      (await page.inputValue(typeSel(0, 3))) === "rest");

    page.once("dialog", (d) => d.accept());   // "this plan is used by…"
    await page.click("#builder-save");
    await page.waitForSelector(".plan-row");

    await L.forceSync(page);
    await page.reload();
    await page.click('#tabs button[data-tab="schedule"]');
    await page.waitForSelector(".week-block");
    if ((await page.getAttribute("#week-1", "open")) === null) {
      await page.click("#week-1 summary");
    }
    L.check("the override survives a save, a sync and a reload",
      (await rowType(3)) === "Rest", await rowType(3));

    /* ---------- clearing the pin returns the day to detection ---------- */
    await page.click('#tabs button[data-tab="plans"]');
    await page.click(".plan-row .edit-plan");
    await page.waitForSelector("#builder-name");
    await page.selectOption(typeSel(0, 3), "");
    page.once("dialog", (d) => d.accept());
    await page.click("#builder-save");
    await page.waitForSelector(".plan-row");
    await page.click('#tabs button[data-tab="schedule"]');
    await page.waitForSelector(".week-block");
    if ((await page.getAttribute("#week-1", "open")) === null) {
      await page.click("#week-1 summary");
    }
    L.check("clearing the pin hands the day back to the classifier",
      (await rowType(3)) === "Easy", await rowType(3));

    /* ---------- an uploaded plan's own types are not re-detected away ----------
     * The SWAP plan's JSON/markdown carries types the parser wouldn't all
     * guess the same way. Opening it in the builder and saving unchanged must
     * not quietly reclassify those days. */
    await page.click('#tabs button[data-tab="plans"]');
    await page.setInputFiles("#plan-file", require("path").join(__dirname, "..", "..", "plans", "swap-12-week-marathon.md"));
    await page.waitForFunction(() =>
      /Added/.test(document.querySelector("#plan-upload-msg")?.textContent || ""),
      null, { timeout: 30000 });
    await page.waitForSelector(".plan-list:not(#shares-list) .plan-row:nth-child(2)");

    const swapRow = '.plan-list:not(#shares-list) .plan-row:has-text("12-Week")';
    const before = await page.locator(swapRow).first().evaluate((li) => li.dataset.plan);
    const typesOf = (id) => page.evaluate((pid) => {
      const raw = localStorage.getItem(
        "marathonTracker.u." + JSON.parse(localStorage.getItem("marathonTracker.lastUser")).id);
      const plan = JSON.parse(raw).plans[pid];
      return plan.weeks.map((w) => w.days.map((d) => d.type).join(",")).join("|");
    }, id);
    const typesBefore = await typesOf(before);

    await page.locator(swapRow).first().locator(".edit-plan").click();
    await page.waitForSelector("#builder-name");
    await page.click("#builder-save");
    await page.waitForSelector(".plan-row");
    const typesAfter = await typesOf(before);
    L.check("saving an uploaded plan unchanged keeps every day's type",
      typesBefore === typesAfter,
      `before=${typesBefore.slice(0, 90)} after=${typesAfter.slice(0, 90)}`);

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nPLAN BUILDER: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
