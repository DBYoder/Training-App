/* Accessibility beyond contrast: keyboard operability, accessible names,
 * announced status changes, and honouring reduced-motion.
 *
 * Contrast and text size are covered by mobile-a11y.js.
 */
"use strict";

const L = require("./lib.js");

/* Every focusable control must expose a name to a screen reader. */
const NAMELESS = `(() => {
  const named = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return true;
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby && document.getElementById(labelledby)) return true;
    if (el.id && document.querySelector(\`label[for="\${CSS.escape(el.id)}"]\`)) return true;
    if (el.closest("label")) return true;
    if (el.title && el.title.trim()) return true;
    return Boolean((el.textContent || "").trim());
  };
  const out = [];
  const sel = "button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]";
  for (const el of document.querySelectorAll(sel)) {
    if (el.disabled || el.hidden || !el.offsetParent) continue;
    if (!named(el)) {
      out.push(el.tagName.toLowerCase() +
        (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/)[0] : "") +
        (el.id ? "#" + el.id : ""));
    }
  }
  return out;
})()`;

/* Walk focus forward with Tab until it lands on `selector`.
 *
 * The element has to be reached the way a keyboard user reaches it: Chromium
 * only matches :focus-visible when the last interaction was a keyboard one, so
 * a programmatic .focus() would report a ring that real users never see —
 * and tabbing proves the control is in the tab order at all. */
async function tabTo(page, selector, max = 60) {
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((sel) => {
      const el = document.activeElement;
      return Boolean(el && el.matches && el.matches(sel));
    }, selector);
    if (hit) return i + 1;
  }
  return null;
}

/* Focus must be visible: a perceivable outline the pointer state doesn't
 * already produce. */
async function focusRing(page, selector) {
  const steps = await tabTo(page, selector);
  if (steps === null) return { reached: false };
  // several controls transition `all`, so the ring animates in; measure the
  // settled value, not a frame partway through it
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const cs = getComputedStyle(document.activeElement);
    return {
      reached: true,
      outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
      visible: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 1,
    };
  });
}

(async () => {
  const server = await L.startServer({ port: Number(process.env.PORT) || 4609 });
  const browser = await L.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 1000 } });
    const page = await ctx.newPage();
    errors.push(...L.trackErrors(page, "a11y"));

    /* ---------- the sign-in screen ---------- */
    await page.goto(server.base);
    await page.waitForSelector("#auth:not([hidden])");
    let nameless = await page.evaluate(NAMELESS);
    L.check("every control on the sign-in screen has an accessible name",
      nameless.length === 0, nameless.join(", "));

    const ring = await focusRing(page, "#auth-submit");
    L.check("the sign-in button is reachable by Tab and shows a focus ring",
      ring.reached && ring.visible, JSON.stringify(ring));

    const emailRing = await focusRing(page, '#auth-form input[name="email"]');
    L.check("text inputs show a focus ring too",
      emailRing.reached && emailRing.visible, JSON.stringify(emailRing));

    /* ---------- the app proper ---------- */
    await L.register(page, server.base, "a11y@example.com");
    await L.createSchedule(page, { anchor: L.upcoming(0, 32) });

    for (const tab of ["today", "schedule", "progress", "plans", "settings"]) {
      await page.click(`#tabs button[data-tab="${tab}"]`);
      await page.waitForTimeout(250);
      nameless = await page.evaluate(NAMELESS);
      L.check(`every control on the ${tab} tab has an accessible name`,
        nameless.length === 0, nameless.join(", "));
    }

    /* ---------- tabs expose themselves properly ---------- */
    await page.click('#tabs button[data-tab="today"]');
    const tabWiring = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll("#tabs button")];
      return {
        selected: buttons.filter((b) => b.getAttribute("aria-selected") === "true").length,
        controls: buttons.every((b) => {
          const id = b.getAttribute("aria-controls");
          return id && document.getElementById(id);
        }),
        panels: [...document.querySelectorAll(".tab-panel")]
          .every((p) => p.getAttribute("role") === "tabpanel"),
      };
    });
    L.check("exactly one tab is marked selected", tabWiring.selected === 1);
    L.check("each tab points at the panel it controls", tabWiring.controls);
    L.check("panels are exposed as tabpanels", tabWiring.panels);

    /* ---------- a day card is reachable and operable by keyboard ---------- */
    await page.click('#tabs button[data-tab="today"]');
    await page.waitForSelector("#tab-today .day-card");
    const cardRing = await focusRing(page, "#tab-today .day-card");
    L.check("a day card is reachable by Tab and shows a focus ring",
      cardRing.reached && cardRing.visible, JSON.stringify(cardRing));

    const tabRing = await focusRing(page, '#tabs button[data-tab="schedule"]');
    L.check("the nav tabs are reachable by Tab and show a focus ring",
      tabRing.reached && tabRing.visible, JSON.stringify(tabRing));

    await tabTo(page, "#tab-today .day-card");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#day-modal[open]");
    L.check("Enter opens the day from the keyboard", true);

    const focusInside = await page.evaluate(() =>
      document.querySelector("#day-modal").contains(document.activeElement));
    L.check("focus moves into the dialog when it opens", focusInside,
      await page.evaluate(() => document.activeElement?.tagName + "." + document.activeElement?.className));

    nameless = await page.evaluate(NAMELESS);
    L.check("every control in the journal dialog has an accessible name",
      nameless.length === 0, nameless.join(", "));

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#day-modal").open);
    L.check("Escape closes the dialog", true);
    const focusRestored = await page.evaluate(() =>
      document.activeElement?.classList.contains("day-card"));
    L.check("focus returns to the card that opened it", focusRestored,
      await page.evaluate(() => document.activeElement?.className));

    /* ---------- status messages are announced, not just shown ---------- */
    const region = await page.evaluate(() => {
      const el = document.querySelector("#a11y-status");
      return el && { live: el.getAttribute("aria-live"), role: el.getAttribute("role") };
    });
    L.check("the page has a persistent polite live region",
      region && region.live === "polite" && region.role === "status", JSON.stringify(region));

    // saving a journal entry shows "Saved ✓" on screen; a screen reader has to
    // hear it too
    await page.evaluate(() => { document.querySelector("#a11y-status").textContent = ""; });
    await tabTo(page, "#tab-today .day-card");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#day-modal[open]");
    await page.fill('#day-modal input[name="distance"]', "6");
    await page.click('#day-modal button[type="submit"]');
    await page.waitForFunction(() =>
      /saved/i.test(document.querySelector("#a11y-status").textContent), null, { timeout: 5000 });
    L.check("saving a journal entry is announced",
      /saved/i.test(await page.textContent("#a11y-status")),
      await page.textContent("#a11y-status"));

    /* ---------- reduced motion is honoured ---------- */
    const motionCtx = await browser.newContext({
      viewport: { width: 1000, height: 900 }, reducedMotion: "reduce",
    });
    const calm = await motionCtx.newPage();
    await L.login(calm, server.base, "a11y@example.com");
    await calm.waitForSelector("#tab-today .day-card");
    const durations = await calm.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("body *")) {
        const cs = getComputedStyle(el);
        const t = parseFloat(cs.transitionDuration) || 0;
        const a = parseFloat(cs.animationDuration) || 0;
        if (t > 0.05 || a > 0.05) {
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]} ${cs.transitionDuration}/${cs.animationDuration}`);
        }
      }
      return out;
    });
    L.check("prefers-reduced-motion switches transitions off",
      durations.length === 0, durations.slice(0, 5).join(" | "));

    // the app must still work with motion off
    await calm.click('#tabs button[data-tab="schedule"]');
    await calm.waitForSelector(".week-block");
    L.check("the app still navigates with reduced motion", true);
    await motionCtx.close();

    if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
    console.log("\nKEYBOARD + SCREEN-READER A11Y: all checks passed");
  } finally {
    await browser.close();
    server.stop();
  }
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
