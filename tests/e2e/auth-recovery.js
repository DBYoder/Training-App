/* Password reset and email verification, end to end.
 *
 * Runs the server with MAIL_PROVIDER=capture so the suite can read the exact
 * links a real inbox would receive, then follows them like a user would.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const L = require("./lib.js");

const captureFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-mail-")), "mail.jsonl");

const mails = () => fs.existsSync(captureFile)
  ? fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const lastLinkTo = (email, kind) => {
  const m = mails().filter((x) => x.to === email && x.text.includes(`?${kind}=`)).pop();
  return m && m.text.match(new RegExp(`https?://\\S+\\?${kind}=[a-f0-9]+`))[0];
};

(async () => {
  const server = await L.startServer({
    port: Number(process.env.PORT) || 4605,
    env: {
      MAIL_PROVIDER: "capture",
      MAIL_CAPTURE_FILE: captureFile,
      REQUIRE_EMAIL_VERIFICATION: "true",
    },
  });
  const browser = await L.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
    const page = await ctx.newPage();
    errors.push(...L.trackErrors(page, "auth", { allowStatus: [400, 401, 404, 409] }));

    /* ---------- registration sends a confirmation ---------- */
    await L.register(page, server.base, "runner@example.com");
    const verifyLink = lastLinkTo("runner@example.com", "verify");
    L.check("registration emails a confirmation link", Boolean(verifyLink));

    await L.createSchedule(page, { anchor: L.upcoming(0, 32) });
    await page.click('#tabs button[data-tab="settings"]');
    await page.waitForSelector("#verify-line");
    L.check("an unconfirmed account is told so",
      (await page.textContent("#verify-line")).includes("isn't confirmed"));

    /* ---------- an unverified account can't receive shares ---------- */
    const ctx2 = await browser.newContext();
    const sharer = await ctx2.newPage();
    errors.push(...L.trackErrors(sharer, "sharer", { allowStatus: [400, 401, 404, 409] }));
    await L.register(sharer, server.base, "sharer@example.com");
    const sharerVerify = lastLinkTo("sharer@example.com", "verify");
    // confirm the sender (they stay signed in from registering)
    await sharer.goto(sharerVerify);
    await sharer.waitForSelector(".schedule-form");
    await L.createSchedule(sharer, { anchor: L.upcoming(0, 40) });
    await sharer.click('#tabs button[data-tab="plans"]');
    await sharer.waitForSelector(".share-plan");
    await sharer.click(".share-plan");
    await sharer.fill(".share-email", "runner@example.com");
    await sharer.click(".share-send");
    await sharer.waitForFunction(() => !/^(|Sending…)$/.test(
      (document.querySelector(".share-msg")?.textContent || "").trim()));
    L.check("sharing to an unconfirmed address is refused",
      (await sharer.textContent(".share-msg")).includes("hasn't confirmed"),
      await sharer.textContent(".share-msg"));

    /* ---------- following the confirmation link ---------- */
    await page.goto(verifyLink);
    await page.waitForSelector("#app-main:not([hidden]), #auth:not([hidden])");
    L.check("the confirmation token is stripped from the URL",
      !page.url().includes("verify="), page.url());
    await page.click('#tabs button[data-tab="settings"]');
    await page.waitForSelector("#verify-line");
    L.check("the account now shows as confirmed",
      (await page.textContent("#verify-line")).includes("confirmed"));

    await sharer.fill(".share-email", "runner@example.com");
    await sharer.click(".share-send");
    await sharer.waitForFunction(() => {
      const t = (document.querySelector(".share-msg")?.textContent || "").trim();
      return t && t !== "Sending…" && !t.includes("hasn't confirmed");
    }, null, { timeout: 15000 }).catch(() => {});
    L.check("sharing works once the address is confirmed",
      (await sharer.textContent(".share-msg")).includes("Sent"),
      "message was: " + JSON.stringify((await sharer.textContent(".share-msg")).trim()));

    /* ---------- a reused confirmation link is refused ---------- */
    const before = mails().length;
    await page.goto(verifyLink);
    await page.waitForSelector("#app-main:not([hidden]), #auth:not([hidden])");
    L.check("tokens are single-use", mails().length === before);

    /* ---------- forgotten password ---------- */
    await page.click('#tabs button[data-tab="settings"]');
    await page.click("#logout");
    await page.waitForSelector("#auth:not([hidden])");
    await page.click("#auth-forgot-link");
    await page.waitForFunction(() => document.querySelector("#auth-title").textContent.includes("Reset"));
    await page.fill('#auth-form input[name="email"]', "runner@example.com");
    await page.click("#auth-submit");
    await page.waitForSelector("#auth-notice:not([hidden])");
    L.check("the reset request gives a neutral answer",
      (await page.textContent("#auth-notice")).includes("If that address has an account"));

    // the same neutral answer for an address with no account, and no email sent
    const mailsBefore = mails().length;
    await page.click("#auth-forgot-link");
    await page.fill('#auth-form input[name="email"]', "stranger@example.com");
    await page.click("#auth-submit");
    await page.waitForSelector("#auth-notice:not([hidden])");
    L.check("an unknown address gets the same answer and no email",
      (await page.textContent("#auth-notice")).includes("If that address has an account") &&
      mails().length === mailsBefore);

    const resetLink = lastLinkTo("runner@example.com", "reset");
    L.check("a reset link was emailed", Boolean(resetLink));

    await page.goto(resetLink);
    await page.waitForFunction(() => document.querySelector("#auth-title").textContent.includes("new password"));
    L.check("the reset token is stripped from the URL", !page.url().includes("reset="));
    L.check("the reset form asks only for a password",
      await page.evaluate(() =>
        document.querySelector('#auth-form input[name="email"]').closest("label").hidden));

    await page.fill('#auth-form input[name="password"]', "brand-new-password");
    await page.click("#auth-submit");
    await page.waitForSelector("#tab-today .day-card, #tab-today .notice, .schedule-form");
    L.check("resetting signs the user straight in with their data intact",
      (await page.textContent("body")).includes("days to race day"));

    /* ---------- old password dead, new one works, link single-use ---------- */
    const ctx3 = await browser.newContext();
    const other = await ctx3.newPage();
    errors.push(...L.trackErrors(other, "other", { allowStatus: [400, 401, 404, 409] }));
    await L.login(other, server.base, "runner@example.com", "password123");
    await other.waitForSelector("#auth-error:not([hidden])");
    L.check("the old password no longer works",
      (await other.textContent("#auth-error")).includes("Wrong email or password"));

    await L.login(other, server.base, "runner@example.com", "brand-new-password");
    await other.waitForSelector("#tab-today .day-card, #tab-today .notice");
    L.check("the new password works",
      (await other.locator("#app-main").isVisible()));

    await other.goto(resetLink);
    await other.waitForFunction(() => document.querySelector("#auth-title").textContent.includes("new password"));
    await other.fill('#auth-form input[name="password"]', "third-password-attempt");
    await other.click("#auth-submit");
    await other.waitForSelector("#auth-error:not([hidden])");
    L.check("a reset link cannot be used twice",
      (await other.textContent("#auth-error")).includes("expired"));

    L.check("no email ever contained a raw password",
      !mails().some((m) => /password123|brand-new-password/.test(m.text)));

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nAUTH RECOVERY: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
