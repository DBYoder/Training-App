/* Race week (splits + the plan's own fuelling + a checklist) and the
 * adherence / streak figures on Progress. */
"use strict";

const L = require("./lib.js");

/* Seed a schedule's journal straight through the API so a realistic history
 * exists without driving the UI 60 times. */
async function seedJournal(page, fill) {
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
    L.check("fuelling comes from the plan's own race-day text",
      card.includes("75–90 g carbs/hour") && card.includes("16–24 oz fluid/hour"),
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

    /* ---------- the checklist ticks and persists ---------- */
    await page.check('#race-week .race-check[data-item="kit"]');
    await page.waitForTimeout(150);
    L.check("a ticked item is struck through",
      await page.evaluate(() =>
        document.querySelector('.race-check[data-item="kit"]').closest("li").classList.contains("done")));
    await L.forceSync(page);
    await page.reload();
    await page.waitForSelector("#race-week");
    L.check("ticks survive a reload",
      await page.isChecked('#race-week .race-check[data-item="kit"]'));
    L.check("other items stay unticked",
      !(await page.isChecked('#race-week .race-check[data-item="fuel"]')));

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
