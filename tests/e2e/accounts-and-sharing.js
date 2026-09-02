/* Multi-user isolation, cross-device sync, and plan sharing — including the
 * sanitisation of a hostile shared plan.
 *
 * This is the suite guarding other people's data, so it is deliberately
 * suspicious: it plants an attack directly against the API rather than
 * through the UI, then confirms the recipient's browser renders it inert.
 */
"use strict";

const L = require("./lib.js");

// the "Shared with you" inbox also renders .plan-row and fills in
// asynchronously, so library assertions must exclude it
const LIB = "#tab-plans .plan-list:not(#shares-list) .plan-row";

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4601 });
  const browser = await L.launch();
  const errors = [];
  try {
    const race = L.upcoming(0, 32); // a Sunday

    /* ---------- user A ---------- */
    const ctxA = await browser.newContext({ viewport: { width: 900, height: 1000 } });
    const a = await ctxA.newPage();
    errors.push(...L.trackErrors(a, "A"));
    await L.register(a, server.base, "a@example.com");
    L.check("registering lands on the setup form with an empty plan library",
      (await a.locator('.schedule-form select[name="planId"] option').count()) === 1 &&
      (await a.textContent('.schedule-form select[name="planId"]')).includes("no plans yet"));
    L.check("submit is disabled until a plan exists",
      await a.locator('.schedule-form button[type="submit"]').isDisabled());

    await L.createSchedule(a, { anchor: race, name: "A's marathon" });
    L.check("schedule created from an uploaded plan",
      (await a.textContent("#countdown-chip")).includes("days to race day"));

    // journal a day so there is private content to leak
    await a.click("#tab-today .day-card");
    await a.waitForSelector("#day-modal[open]");
    await a.selectOption('#journal-form select[name="status"]', "completed");
    await a.fill('#journal-form input[name="distance"]', "9");
    await a.fill('#journal-form input[name="duration"]', "1:12:00");
    await a.fill('#journal-form textarea[name="notes"]', "A-PRIVATE-NOTE");
    await a.click('#journal-form button[type="submit"]');
    await a.waitForSelector("#save-confirm:not([hidden])");
    await a.click("#modal-close");
    L.check("journal entry saved with computed pace",
      (await a.textContent("#tab-today .day-card")).includes("8:00/mi"));
    await L.forceSync(a);

    /* ---------- same user, second device ---------- */
    const ctxB = await browser.newContext();
    const b = await ctxB.newPage();
    errors.push(...L.trackErrors(b, "B"));
    await L.login(b, server.base, "a@example.com");
    await b.waitForSelector("#tab-today .day-card");
    L.check("a second device sees the same schedule and journal",
      (await b.textContent("#tab-today .day-card")).includes("9 mi"));

    /* ---------- user B: isolation ---------- */
    const ctxC = await browser.newContext();
    const c = await ctxC.newPage();
    errors.push(...L.trackErrors(c, "C"));
    await c.goto(server.base);
    await c.waitForSelector("#auth:not([hidden])");
    await c.fill('#auth-form input[name="email"]', "a@example.com");
    await c.fill('#auth-form input[name="password"]', "wrong-password");
    await c.click("#auth-submit");
    await c.waitForSelector("#auth-error:not([hidden])");
    L.check("wrong password is rejected",
      (await c.textContent("#auth-error")).includes("Wrong email or password"));

    await c.click("#auth-switch-link");
    await c.fill('#auth-form input[name="password"]', "password456");
    await c.click("#auth-submit");
    await c.waitForSelector("#auth-error:not([hidden])");
    L.check("registering a taken email is rejected",
      (await c.textContent("#auth-error")).includes("already an account"));

    await L.register(c, server.base, "c@example.com");
    const cBody = await c.textContent("body");
    L.check("a new account sees none of another user's data",
      !cBody.includes("A-PRIVATE-NOTE") && !cBody.includes("A's marathon"));
    await c.click('#tabs button[data-tab="plans"]');
    await c.waitForSelector("#plan-file", { state: "attached" });
    L.check("a new account's plan library is empty",
      (await c.locator(LIB).count()) === 0);

    // a context that has never logged in, so it carries no session cookie
    const anonCtx = await browser.newContext();
    const anonData = await anonCtx.request.get(server.base + "/api/data");
    const anonShares = await anonCtx.request.get(server.base + "/api/shares");
    L.check("/api/data and /api/shares refuse unauthenticated reads",
      anonData.status() === 401 && anonShares.status() === 401,
      `got ${anonData.status()} / ${anonShares.status()}`);
    await anonCtx.close();

    /* ---------- sharing ---------- */
    await a.click('#tabs button[data-tab="plans"]');
    await a.waitForSelector("#tab-plans .plan-row .share-plan");
    await a.click(".share-plan");
    await a.waitForSelector(".share-email");
    await a.fill(".share-email", "nobody@example.com");
    await a.click(".share-send");
    await a.waitForFunction(() => (document.querySelector(".share-msg")?.textContent || "").length > 8,
      null, { timeout: 10000 }).catch(() => {});
    L.check("sharing to an unknown address fails cleanly",
      (await a.textContent(".share-msg")).includes("No account"),
      "message was: " + JSON.stringify(await a.textContent(".share-msg")));

    await a.fill(".share-email", "a@example.com");
    await a.click(".share-send");
    await a.waitForFunction(() => !/^(|Sending…)$/.test(
      (document.querySelector(".share-msg")?.textContent || "").trim()), null, { timeout: 10000 }).catch(() => {});
    L.check("sharing with yourself is refused",
      /that's you|someone else/i.test(await a.textContent(".share-msg")),
      "message was: " + JSON.stringify((await a.textContent(".share-msg")).trim()));

    await a.fill(".share-email", "c@example.com");
    await a.click(".share-send");
    await a.waitForFunction(() => !/^(|Sending…)$/.test(
      (document.querySelector(".share-msg")?.textContent || "").trim()), null, { timeout: 10000 }).catch(() => {});
    L.check("sharing to a real account succeeds",
      (await a.textContent(".share-msg")).includes("Sent"),
      "message was: " + JSON.stringify((await a.textContent(".share-msg")).trim()));

    /* ---------- a hostile plan, planted straight at the API ---------- */
    const status = await a.evaluate(async (email) => {
      const res = await fetch("/api/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          plan: {
            name: "<img src=x onerror=window.__pwned=1>Evil Plan",
            dayHeaders: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            htmlDetails: true,
            weeks: [{
              days: Array.from({ length: 7 }, () => ({
                type: "easy",
                title: "<img src=x onerror=window.__pwned=1>run",
                details: ['<img src=x onerror="window.__pwned=1">5 mi easy'],
              })),
            }],
          },
        }),
      });
      return res.status;
    }, "c@example.com");
    L.check("hostile share accepted by the API (the client must defend itself)", status === 200);

    await c.click('#tabs button[data-tab="plans"]');
    await c.waitForSelector("#shared-inbox:not([hidden]) .plan-row");
    L.check("recipient sees both shares in the inbox",
      (await c.locator("#shares-list .plan-row").count()) === 2);

    await c.locator(".accept-share").first().click();
    await c.waitForFunction((sel) => document.querySelectorAll(sel).length === 1, LIB);
    L.check("accepted plan lands in the library with provenance",
      (await c.textContent(LIB)).includes("from a@example.com"));

    // accept the hostile one and actually render its content
    await c.waitForSelector("#shared-inbox:not([hidden]) .accept-share");
    await c.locator(".accept-share").first().click();
    await c.waitForFunction((sel) =>
      [...document.querySelectorAll(sel)].some((r) => r.textContent.includes("Evil Plan")), LIB);
    const evilIdx = (await c.locator(LIB).allTextContents()).findIndex((t) => t.includes("Evil Plan"));
    await c.locator(LIB).nth(evilIdx).locator(".use-plan").click();
    await c.waitForSelector("#new-schedule-details[open] .schedule-form");
    L.check("the hostile plan is the one selected for scheduling",
      (await c.evaluate(() =>
        document.querySelector('.schedule-form select[name="planId"]')
          .selectedOptions[0]?.textContent || "")).includes("Evil Plan"));
    await c.check('.schedule-form input[value="start"]');
    await c.click('.schedule-form button[type="submit"]');
    await c.waitForSelector("#tab-today .day-card, #tab-today .notice");
    await c.click("#tab-today .day-card");
    await c.waitForSelector("#day-modal[open]");
    const details = await c.textContent("#day-modal .workout-details");
    const html = await c.evaluate(() => document.querySelector("#day-modal .workout-details").innerHTML);
    const nodes = await c.evaluate(() =>
      document.querySelector("#day-modal .workout-details").querySelectorAll("script, img").length);
    const title = await c.textContent("#modal-title");
    L.check("hostile markup is stripped but the text survives",
      details.includes("5 mi easy") && nodes === 0,
      `title=${JSON.stringify(title)} nodes=${nodes} html=${JSON.stringify(html.slice(0, 200))}`);
    L.check("no script from the shared plan executed",
      (await c.evaluate(() => window.__pwned)) === undefined);
    await c.click("#modal-close");

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nACCOUNTS + SHARING: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
