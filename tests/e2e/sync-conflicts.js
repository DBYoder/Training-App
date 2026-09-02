/* Two devices editing the same day while one is offline.
 *
 * Last-write-wins still decides the merge, but the replaced edit must be
 * surfaced and recoverable rather than vanishing silently.
 */
"use strict";

const L = require("./lib.js");

const journalDay = async (page, { distance, notes }) => {
  await page.click("#tab-today .day-card");
  await page.waitForSelector("#day-modal[open]");
  await page.selectOption('#journal-form select[name="status"]', "completed");
  await page.fill('#journal-form input[name="distance"]', String(distance));
  await page.fill('#journal-form textarea[name="notes"]', notes);
  await page.click('#journal-form button[type="submit"]');
  await page.waitForSelector("#save-confirm:not([hidden])");
  await page.click("#modal-close");
};

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4607 });
  const browser = await L.launch();
  const errors = [];
  try {
    /* ---------- one account, two devices, both synced ---------- */
    const ctxA = await browser.newContext({ viewport: { width: 900, height: 1000 } });
    const a = await ctxA.newPage();
    errors.push(...L.trackErrors(a, "A"));
    await L.register(a, server.base, "conflict@example.com");
    await L.createSchedule(a, { anchor: L.upcoming(0, 32) });
    await L.forceSync(a);

    const ctxB = await browser.newContext({ viewport: { width: 900, height: 1000 } });
    const b = await ctxB.newPage();
    errors.push(...L.trackErrors(b, "B"));
    await L.login(b, server.base, "conflict@example.com");
    await b.waitForSelector("#tab-today .day-card");
    await L.forceSync(b);
    L.check("both devices start from the same synced state", true);

    /* ---------- device A goes offline and logs the run ---------- */
    await ctxA.setOffline(true);
    await a.click('#tabs button[data-tab="today"]');
    await journalDay(a, { distance: 11, notes: "A-VERSION logged on the watch" });
    L.check("the offline device saves locally",
      (await a.textContent("#tab-today .day-card")).includes("11 mi"));

    /* ---------- meanwhile device B logs the same day differently ---------- */
    await b.click('#tabs button[data-tab="today"]');
    await journalDay(b, { distance: 9, notes: "B-VERSION typed on the laptop" });
    await L.forceSync(b);
    L.check("the online device syncs its version",
      (await b.textContent("#tab-today .day-card")).includes("9 mi"));

    /* ---------- A comes back online ---------- */
    await ctxA.setOffline(false);
    await L.forceSync(a);
    await a.click('#tabs button[data-tab="today"]');
    await a.waitForSelector("#conflict-card");
    L.check("the replaced edit is reported, not silently dropped",
      (await a.textContent("#conflict-card")).includes("replaced by another device"));

    await a.click("#conflict-card summary");
    const detail = await a.textContent("#conflict-card");
    L.check("both versions are shown so the runner can choose",
      /A-VERSION|11 mi/.test(detail) && /B-VERSION|9 mi/.test(detail),
      detail.replace(/\s+/g, " ").slice(0, 200));

    /* ---------- restoring the replaced version ---------- */
    const kept = (await a.textContent("#tab-today .day-card")).includes("11 mi") ? "A" : "B";
    await a.click(".restore-conflict");
    await a.waitForFunction(() => !document.querySelector("#conflict-card"));
    const afterRestore = await a.textContent("#tab-today .day-card");
    L.check("restoring swaps in the version that had been replaced",
      kept === "A" ? afterRestore.includes("9 mi") : afterRestore.includes("11 mi"),
      `kept=${kept} now=${afterRestore.replace(/\s+/g, " ").slice(0, 80)}`);
    L.check("the banner clears once handled",
      (await a.locator("#conflict-card").count()) === 0);

    /* ---------- the restored version wins on the other device too ---------- */
    await L.forceSync(a);
    await L.forceSync(b);
    await b.click('#tabs button[data-tab="today"]');
    const bAfter = await b.textContent("#tab-today .day-card");
    L.check("the restored version propagates to the other device",
      kept === "A" ? bAfter.includes("9 mi") : bAfter.includes("11 mi"),
      bAfter.replace(/\s+/g, " ").slice(0, 80));

    /* ---------- a one-sided edit is NOT a conflict ---------- */
    await a.click('#tabs button[data-tab="today"]');
    await journalDay(a, { distance: 7, notes: "only device A touched this" });
    await L.forceSync(a);
    await L.forceSync(b);
    await b.click('#tabs button[data-tab="today"]');
    L.check("an ordinary edit from one device raises no conflict",
      (await b.locator("#conflict-card").count()) === 0 &&
      (await b.textContent("#tab-today .day-card")).includes("7 mi"));

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nSYNC CONFLICTS: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
