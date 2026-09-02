/* P1 hardening: security headers, account deletion, persistent rate limits. */
"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./lib.js");

(async () => {
  const port = Number(process.env.PORT) || 4606;
  let server = await L.startServer({ port });
  const browser = await L.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
    const page = await ctx.newPage();
    errors.push(...L.trackErrors(page, "hard", { allowStatus: [400, 401, 403, 404, 409, 429] }));

    /* ---------- security headers ---------- */
    const htmlRes = await ctx.request.get(server.base + "/");
    const h = htmlRes.headers();
    L.check("HTML carries a Content-Security-Policy",
      (h["content-security-policy"] || "").includes("default-src 'self'"), h["content-security-policy"]);
    L.check("CSP forbids framing and inline script",
      (h["content-security-policy"] || "").includes("frame-ancestors 'none'") &&
      !(h["content-security-policy"] || "").includes("unsafe-inline"));
    L.check("nosniff and frame protection are set",
      h["x-content-type-options"] === "nosniff" && h["x-frame-options"] === "DENY");
    L.check("Referrer-Policy keeps emailed tokens out of Referer headers",
      (h["referrer-policy"] || "").includes("strict-origin"));

    const apiRes = await ctx.request.get(server.base + "/api/me");
    L.check("API responses are nosniff too",
      apiRes.headers()["x-content-type-options"] === "nosniff");

    /* the CSP must not break the app it protects */
    await L.register(page, server.base, "hard@example.com");
    await L.createSchedule(page, { anchor: L.upcoming(0, 32) });
    L.check("the app still runs under CSP (no violations, schedule created)",
      (await page.textContent("#countdown-chip")).includes("days to race day") && !errors.length,
      errors.join("; "));

    /* ---------- account deletion ---------- */
    await page.click('#tabs button[data-tab="settings"]');
    await page.waitForSelector("#delete-account");
    await page.click("#delete-account");
    await page.fill("#delete-password", "not-my-password");
    page.once("dialog", (d) => d.accept());
    await page.click("#delete-account-go");
    await page.waitForFunction(() =>
      (document.querySelector("#delete-msg")?.textContent || "").includes("isn't right"));
    L.check("deleting requires the correct password", true);

    const dataDir = server.dataDir;
    const userFiles = () => fs.existsSync(path.join(dataDir, "users"))
      ? fs.readdirSync(path.join(dataDir, "users")) : [];
    L.check("the account still exists after a failed attempt", userFiles().length === 1);

    await page.fill("#delete-password", "password123");
    page.once("dialog", (d) => d.accept());
    await page.click("#delete-account-go");
    await page.waitForSelector("#auth:not([hidden])");
    L.check("deleting signs the user out with a confirmation",
      (await page.textContent("#auth-notice")).includes("deleted"));
    L.check("every file the account owned is gone",
      userFiles().length === 0 &&
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(dataDir, "users.json"), "utf8"))) === "{}" &&
      (!fs.existsSync(path.join(dataDir, "userdata")) ||
        fs.readdirSync(path.join(dataDir, "userdata")).length === 0));

    await L.login(page, server.base, "hard@example.com", "password123");
    await page.waitForSelector("#auth-error:not([hidden])");
    L.check("the deleted account can no longer sign in",
      (await page.textContent("#auth-error")).includes("Wrong email or password"));

    // the address is free again
    await L.register(page, server.base, "hard@example.com");
    L.check("the email can be registered again", await page.locator(".schedule-form").isVisible());

    /* ---------- rate limits survive a restart ---------- */
    const rateFile = path.join(dataDir, "ratelimit.json");
    await page.waitForTimeout(6000); // let the throttled flush land
    L.check("rate-limit counters are written to disk", fs.existsSync(rateFile));
    const before = Object.values(JSON.parse(fs.readFileSync(rateFile, "utf8")))
      .reduce((n, r) => n + r.count, 0);
    L.check("the counters hold real attempts", before > 0, `count=${before}`);

    // restart against the same volume, exactly as a Railway redeploy would
    await server.restart();
    const probe = await ctx.request.post(server.base + "/api/login",
      { data: { email: "nobody@example.com", password: "x" } });
    await new Promise((r) => setTimeout(r, 6500)); // let the throttled flush land
    const after = Object.values(JSON.parse(fs.readFileSync(rateFile, "utf8")))
      .reduce((n, r) => n + r.count, 0);
    L.check("a restarted server keeps counting from the persisted total, not zero",
      after > before, `before=${before} after=${after} (probe ${probe.status()})`);

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nHARDENING: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
