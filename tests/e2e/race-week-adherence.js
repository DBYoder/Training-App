/* Race week (splits + the plan's own fuelling + a checklist) and the
 * adherence / streak figures on Progress. */
"use strict";

const L = require("./lib.js");

/* Seed a schedule's journal straight through the API so a realistic history
 * exists without driving the UI 60 times. */
async function seedJournal(page, fill) {
  // Flush anything the app is holding first: on reload it fires its
  // pagehide keepalive push, which would otherwise overwrite this seed with
  // the in-memory state (that push working is a feature, not a bug).
  await L.forceSync(page);
  await page.evaluate(async (fillSrc) => {
    const decide = new Function("return " + fillSrc)();
    const { state } = await (await fetch("/api/data")).json();
    const sid = state.activeScheduleId;
    const sched = state.schedules[sid];
    const plan = state.plans[sched.planId];
    const days = plan.weeks.flatMap((w, wi) => w.days.map((d) => ({ week: wi + 1, ...d })));
    const anchor = new Date(sched.anchorDate + "T12:00:00");
    const start = new Date(anchor);
    start.setDate(start.getDate() - (days.length - 1));
    const now = new Date();
    const todayIdx = Math.round(
      (new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12) - start) / 86400000);
    const journal = {};
    for (let i = 0; i < todayIdx; i++) {
      const entry = decide(i, days[i], todayIdx);
      if (entry) journal[i] = { ...entry, updatedAt: new Date().toISOString() };
    }
    state.journal[sid] = journal;
    await fetch("/api/data", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
    localStorage.removeItem(
      "marathonTracker.u." + JSON.parse(localStorage.getItem("marathonTracker.lastUser")).id);
  }, fill.toString());
  await page.reload();
  await page.waitForSelector("#tab-today .day-card, #tab-today .notice");
}

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4608 });
  const browser = await L.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 1100 } })).newPage();
    errors.push(...L.trackErrors(page, "race"));

    /* the race is the coming Sunday, so today sits inside race week */
    const race = L.upcoming(0, 3);
    await L.register(page, server.base, "raceweek@example.com");
    await L.createSchedule(page, { anchor: race });

    /* ---------- race week appears, with the plan's own guidance ---------- */
    await page.waitForSelector("#race-week");
    const card = await page.textContent("#race-week");
    L.check("the race-week card appears in the final week",
      /race week/i.test(card), card.replace(/\s+/g, " ").slice(0, 80));
    L.check("it says how far out the race is",
      /Today|In \d+ day/.test(card));
    L.check("the plan's own race-day fuelling is surfaced",
      card.includes("Your plan suggests 75–90 g/h") && card.includes("16–24 oz/h"),
      card.replace(/\s+/g, " ").slice(0, 220));
    L.check("without pace zones it asks for a race result rather than inventing splits",
      card.includes("pace zones") && (await page.locator("#race-week .split").count()) === 0);

    /* ---------- splits appear once fitness is known ---------- */
    await page.click('#tabs button[data-tab="settings"]');
    await page.waitForSelector("#pace-card");
    await page.selectOption("#pace-dist", "5k");
    await page.fill("#pace-time", "19:57");          // the canonical VDOT 50
    await page.click("#pace-save");
    await page.waitForSelector("#pace-card .pace-chip");
    await page.click('#tabs button[data-tab="today"]');
    await page.waitForSelector("#race-week .split");
    const splits = await page.locator("#race-week .split").allTextContents();
    L.check("six goal-pace splits are shown", splits.length === 6, splits.join(" | "));
    const withPlan = await page.textContent("#race-week");
    L.check("splits are built on the runner's own fitness (VDOT 50 ≈ 3:10 marathon)",
      /3:1\d:\d\d/.test(withPlan) && withPlan.includes("current fitness"),
      withPlan.replace(/\s+/g, " ").slice(0, 200));
    L.check("the finish split matches the target time",
      splits[5].includes("3:1"), splits[5]);

    /* an over-ambitious goal must not become the race-day plan */
    await page.click('#tabs button[data-tab="settings"]');
    await page.fill("#pace-goal", "2:45:00");
    await page.click("#pace-save");
    await page.click('#tabs button[data-tab="today"]');
    await page.waitForSelector("#race-week .split");
    const optimistic = await page.textContent("#race-week");
    L.check("an unrealistic goal doesn't drive the splits",
      optimistic.includes("ahead of what your last race predicts") &&
      !/2:4\d:\d\d/.test(optimistic),
      optimistic.replace(/\s+/g, " ").slice(0, 240));

    /* a realistic goal is used */
    await page.click('#tabs button[data-tab="settings"]');
    await page.fill("#pace-goal", "3:15:00");
    await page.click("#pace-save");
    await page.click('#tabs button[data-tab="today"]');
    await page.waitForSelector("#race-week .split");
    const realistic = await page.textContent("#race-week");
    L.check("a realistic goal is what the splits target",
      realistic.includes("your goal time") && realistic.includes("3:15:00"),
      realistic.replace(/\s+/g, " ").slice(0, 160));

    /* ---------- fuelling is seeded from the plan, then editable ---------- */
    L.check("fuelling is seeded from the plan's own numbers",
      (await page.inputValue("#fuel-carbs")) === "75–90" &&
      (await page.inputValue("#fuel-fluid")) === "16–24",
      `${await page.inputValue("#fuel-carbs")} / ${await page.inputValue("#fuel-fluid")}`);
    // 75–90 g/h across the 3:15 target = 244–293 g
    L.check("the seeded total is derived from the target time",
      /244–293 g of carbs over 3:15:00/.test(await page.textContent("#fuel-total")),
      await page.textContent("#fuel-total"));

    await page.fill("#fuel-carbs", "90");   // 90 g/h across 3:15 = 293 g
    await page.waitForFunction(() =>
      /\b293 g\b/.test(document.querySelector("#fuel-total").textContent));
    L.check("the total recomputes live as carbs are edited",
      /293 g/.test(await page.textContent("#fuel-total")) &&
      !/244/.test(await page.textContent("#fuel-total")));

    await page.fill("#fuel-fluid", "24 oz cold");
    await page.fill("#fuel-notes",
      "Gel 15 min before the gun, then one every 30 min from mile 6. Electrolyte every second aid station.");
    await page.locator("#checklist-new").focus();
    await page.waitForTimeout(500);   // let the debounced save land
    await L.forceSync(page);
    await page.reload();
    await page.waitForSelector("#race-week");
    L.check("edited fuelling survives a reload",
      (await page.inputValue("#fuel-carbs")) === "90" &&
      (await page.inputValue("#fuel-fluid")) === "24 oz cold" &&
      (await page.inputValue("#fuel-notes")).includes("every 30 min from mile 6"),
      `carbs=${JSON.stringify(await page.inputValue("#fuel-carbs"))} ` +
      `fluid=${JSON.stringify(await page.inputValue("#fuel-fluid"))} ` +
      `notes=${JSON.stringify((await page.inputValue("#fuel-notes")).slice(0, 40))}`);
    L.check("the plan's original suggestion is still shown for reference",
      (await page.textContent("#race-week")).includes("Your plan suggests 75–90 g/h"));

    await page.click("#fuel-reset");
    await page.waitForFunction(() =>
      document.querySelector("#fuel-carbs").value === "75–90");
    L.check("reset restores the plan's numbers but keeps your notes",
      (await page.inputValue("#fuel-fluid")) === "16–24" &&
      (await page.inputValue("#fuel-notes")).includes("every 30 min from mile 6"));

    /* ---------- the checklist is the runner's own ---------- */
    const items = () => page.locator("#race-checklist li");
    const seeded = await items().count();
    L.check("a starter checklist is seeded so it's useful immediately", seeded > 0, `${seeded} items`);

    await page.fill("#checklist-new", "Drop bag at gear check by 6:30");
    await page.click("#checklist-add");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#race-checklist li").length === n + 1, seeded);
    L.check("a runner can add their own item",
      (await page.textContent("#race-checklist")).includes("Drop bag at gear check"));

    // Enter adds too, without submitting anything else
    await page.fill("#checklist-new", "Text Sam the tracking link");
    await page.press("#checklist-new", "Enter");
    await page.waitForFunction((n) =>
      document.querySelectorAll("#race-checklist li").length === n + 2, seeded);
    L.check("Enter adds an item as well",
      (await page.textContent("#race-checklist")).includes("Text Sam"));

    // every seeded item can be removed — nothing is fixed
    for (let i = 0; i < seeded; i++) {
      await page.locator("#race-checklist .checklist-remove").first().click();
      await page.waitForTimeout(60);
    }
    const remaining = await items().allTextContents();
    L.check("every predefined item can be deleted",
      remaining.length === 2 &&
      remaining.every((t) => /Drop bag|Text Sam/.test(t)),
      remaining.join(" | "));

    await page.check('#race-checklist input[type="checkbox"]');
    await page.waitForTimeout(120);
    L.check("ticking a custom item strikes it through",
      await page.evaluate(() =>
        document.querySelector("#race-checklist li").classList.contains("done")));

    await L.forceSync(page);
    await page.reload();
    await page.waitForSelector("#race-week");
    const afterReload = await page.textContent("#race-checklist");
    L.check("the custom list survives a reload",
      afterReload.includes("Drop bag at gear check") &&
      afterReload.includes("Text Sam") &&
      !afterReload.includes("Lay out kit"),
      afterReload.replace(/\s+/g, " ").slice(0, 160));
    L.check("the tick survives too",
      await page.isChecked('#race-checklist input[type="checkbox"]'));

    // and it reaches another device
    const ctx2 = await browser.newContext();
    const other = await ctx2.newPage();
    errors.push(...L.trackErrors(other, "other"));
    await L.login(other, server.base, "raceweek@example.com");
    await other.waitForSelector("#race-checklist");
    L.check("the checklist syncs to another device",
      (await other.textContent("#race-checklist")).includes("Drop bag at gear check"));
    L.check("the fuelling plan syncs to another device",
      (await other.inputValue("#fuel-notes")).includes("every 30 min from mile 6"),
      await other.inputValue("#fuel-notes"));

    // a custom item is escaped, never rendered as markup
    await page.fill("#checklist-new", "<img src=x onerror=window.__pwn=1>bring tape");
    await page.click("#checklist-add");
    await page.waitForFunction(() =>
      document.querySelector("#race-checklist").textContent.includes("bring tape"));
    L.check("checklist text is escaped, not rendered",
      (await page.evaluate(() =>
        document.querySelector("#race-checklist").querySelectorAll("img").length)) === 0 &&
      (await page.evaluate(() => window.__pwn)) === undefined);

    /* ---------- adherence & streak ---------- */
    // every scheduled run done except one skipped day early on
    await seedJournal(page, (i, day) => {
      if (day.type === "rest") return null;
      if (i === 5) return { status: "skipped" };
      return { status: "completed", distance: 8, duration: "1:04:00" };
    });
    await page.click('#tabs button[data-tab="progress"]');
    await page.waitForSelector(".stat-tile");
    const tiles = (await page.locator(".stat-tile").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    const adherence = tiles.find((t) => /adherence/i.test(t));
    const streak = tiles.find((t) => /streak/i.test(t));
    L.check("an adherence percentage is shown", Boolean(adherence), tiles.join(" | "));
    L.check("adherence is high but not 100% after one skipped run",
      /9\d%/.test(adherence), adherence);
    L.check("a streak is shown and survived the early skip",
      Boolean(streak) && parseInt(streak, 10) > 10, streak);

    // now skip the most recent scheduled run: the streak must break
    await seedJournal(page, (i, day, todayIdx) => {
      if (day.type === "rest") return null;
      if (i >= todayIdx - 1) return { status: "skipped" };
      return { status: "completed", distance: 8, duration: "1:04:00" };
    });
    await page.click('#tabs button[data-tab="progress"]');
    await page.waitForSelector(".stat-tile");
    const after = (await page.locator(".stat-tile").allTextContents()).map((t) => t.replace(/\s+/g, " ").trim());
    const streakAfter = after.find((t) => /streak/i.test(t));
    L.check("skipping the latest run resets the current streak",
      parseInt(streakAfter, 10) <= 1, streakAfter);
    L.check("but the best streak is remembered", /best \d+/.test(streakAfter), streakAfter);

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nRACE WEEK + ADHERENCE: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
