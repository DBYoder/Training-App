/* The Race tab as a planning surface for the whole block.
 *
 * The point of promoting race planning out of the final seven days is that
 * fuelling and pacing are decisions you rehearse during training. So the
 * cases that matter are the ones far from race day — and the schedule that
 * has no race day at all.
 */
"use strict";

const L = require("./lib.js");

const selected = (page, tab) =>
  page.locator(`#tabs button[data-tab="${tab}"]`).evaluate(
    (b) => b.getAttribute("aria-selected") === "true");

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4611 });
  const browser = await L.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
    const page = await ctx.newPage();
    errors.push(...L.trackErrors(page, "racetab"));

    /* a race ~11 weeks out: deep in the block, nowhere near race week */
    await L.register(page, server.base, "racetab@example.com");
    await L.createSchedule(page, { anchor: L.upcoming(0, 60) });

    L.check("Today shows no race-week banner this far out",
      (await page.locator(".race-banner").count()) === 0);

    await page.click('#tabs button[data-tab="race"]');
    await page.waitForSelector("#race-week");
    const far = await page.textContent("#race-week");
    L.check("the race plan is reachable months out, not just in race week",
      /race day/i.test(far) && /In \d+ days/.test(far),
      far.replace(/\s+/g, " ").slice(0, 120));
    L.check("far out, it frames itself as something to rehearse",
      /rehearse/i.test(far), far.replace(/\s+/g, " ").slice(0, 200));

    /* the plan is fully editable this early — that's the whole point */
    await page.fill("#fuel-carbs", "80");
    await page.fill("#fuel-notes", "Trial this on the week 6 long run.");
    await page.fill("#checklist-new", "Test gels on a long run");
    await page.click("#checklist-add");
    await page.waitForFunction(() =>
      document.querySelector("#race-checklist").textContent.includes("Test gels"));
    await page.waitForTimeout(500);   // debounced fuelling save
    await L.forceSync(page);
    await page.reload();
    await page.click('#tabs button[data-tab="race"]');
    await page.waitForSelector("#race-week");
    L.check("planning done early is kept",
      (await page.inputValue("#fuel-carbs")) === "80" &&
      (await page.inputValue("#fuel-notes")).includes("week 6 long run") &&
      (await page.textContent("#race-checklist")).includes("Test gels"),
      `${await page.inputValue("#fuel-carbs")} / ${await page.inputValue("#fuel-notes")}`);

    /* ---------- a start-date schedule has no race to plan ---------- */
    await page.click('#tabs button[data-tab="settings"]');
    // with a schedule already in place the form sits behind a collapsed details
    await page.waitForSelector("#new-schedule-details");
    if ((await page.getAttribute("#new-schedule-details", "open")) === null) {
      await page.click("#new-schedule-details summary");
    }
    await page.waitForSelector(".schedule-form:visible");
    await L.createSchedule(page, {
      anchor: new Date(), mode: "start", name: "Base block",
    });
    L.check("the Race tab hides itself for a schedule with no goal race",
      await page.locator('#tabs button[data-tab="race"]').isHidden());

    /* switching back to the race-anchored schedule brings the tab back */
    await page.click('#tabs button[data-tab="settings"]');
    await page.waitForSelector(".activate-sched");
    await page.locator(".activate-sched").first().click();
    await page.waitForTimeout(300);
    L.check("the Race tab returns with a race-anchored schedule",
      await page.locator('#tabs button[data-tab="race"]').isVisible());

    await page.click('#tabs button[data-tab="race"]');
    await page.waitForSelector("#race-week");
    L.check("and it still holds the planning done earlier",
      (await page.inputValue("#fuel-notes")).includes("week 6 long run"));

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nRACE TAB: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
