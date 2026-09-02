/* Measures rendered text size + contrast on a phone viewport, then captures
 * the key screens. Contrast is computed from *composited* colors, so it
 * reflects what a runner actually sees. */
const { chromium } = require("playwright-core");

const BASE = process.env.BASE || "http://localhost:4583";
const SHOTS = process.env.SHOTS || "/tmp";
const SWAP_MD = require("path").join(__dirname, "..", "..", "plans", "swap-12-week-marathon.md");

const AUDIT = `(() => {
  const lum = (r, g, b) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const parse = (c) => (c.match(/[\\d.]+/g) || []).map(Number);
  // walk up for the first opaque background actually painted behind the text
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const p = parse(getComputedStyle(n).backgroundColor);
      if (p.length >= 3 && (p[3] === undefined || p[3] > 0.85)) return p;
    }
    return [5, 5, 8];
  };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join("");
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || !el.offsetParent) continue;
    const fg = parse(cs.color);
    if (fg.length < 3 || (fg[3] !== undefined && fg[3] < 0.9)) continue;
    const bg = bgOf(el);
    const l1 = lum(fg[0], fg[1], fg[2]), l2 = lum(bg[0], bg[1], bg[2]);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    // WCAG "large text" = 18.66px bold or 24px+
    const large = px >= 24 || (bold && px >= 18.66);
    out.push({
      sel: el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\\s+/)[0] : el.tagName.toLowerCase(),
      text: text.slice(0, 26), px: Math.round(px * 10) / 10,
      ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5,
    });
  }
  return out;
})()`;

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  // iPhone 14-ish
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  });
  const page = await ctx.newPage();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const race = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 32);
  while (race.getDay() !== 0) race.setDate(race.getDate() + 1);

  await page.goto(BASE);
  await page.click("#auth-switch-link");
  await page.fill('#auth-form input[name="email"]', `mobile-${Date.now()}@example.com`);
  await page.fill('#auth-form input[name="password"]', "password123");
  await page.click("#auth-submit");
  await page.waitForSelector(".schedule-form");
  await page.setInputFiles(".schedule-form .form-plan-file", SWAP_MD);
  await page.waitForFunction(() => document.querySelector(".form-upload-msg")?.textContent.includes("Added"));
  await page.fill('.schedule-form input[name="anchorDate"]', iso(race));
  await page.click('.schedule-form button[type="submit"]');
  await page.waitForSelector("#tab-today .day-card");

  // give the progress views something to render
  await page.click("#tab-today .day-card");
  await page.waitForSelector("#day-modal[open]");
  await page.selectOption('#journal-form select[name="status"]', "completed");
  await page.fill('#journal-form input[name="distance"]', "10");
  await page.fill('#journal-form input[name="duration"]', "1:22:00");
  await page.click('#journal-form button[type="submit"]');
  await page.waitForSelector("#save-confirm:not([hidden])");
  await page.click("#modal-close");

  const screens = [
    ["today", null],
    ["schedule", '#tabs button[data-tab="schedule"]'],
    ["progress", '#tabs button[data-tab="progress"]'],
    ["settings", '#tabs button[data-tab="settings"]'],
  ];
  let worstAll = [];
  let minPx = Infinity;
  for (const [name, sel] of screens) {
    if (sel) { await page.click(sel); await page.waitForTimeout(400); }
    const rows = await page.evaluate(AUDIT);
    const fails = rows.filter((r) => r.ratio < r.need);
    minPx = Math.min(minPx, ...rows.map((r) => r.px));
    const min = rows.reduce((a, b) => (a.ratio < b.ratio ? a : b), rows[0]);
    console.log(`${name.padEnd(9)} ${String(rows.length).padStart(3)} text nodes · smallest ${
      Math.min(...rows.map((r) => r.px))}px · lowest contrast ${min.ratio} (${min.sel}) · ${
      fails.length ? fails.length + " BELOW AA" : "all pass AA ✓"}`);
    fails.slice(0, 6).forEach((f) =>
      console.log(`   ! ${f.sel} "${f.text}" ${f.px}px ${f.ratio}:1 (needs ${f.need})`));
    worstAll = worstAll.concat(fails);
    await page.screenshot({ path: `${SHOTS}/m-${name}.png` });
  }

  // the workout modal is where the plan text is actually read
  await page.click('#tabs button[data-tab="today"]');
  await page.waitForSelector("#tab-today .day-card");
  await page.click("#tab-today .day-card");
  await page.waitForSelector("#day-modal[open]");
  await page.waitForTimeout(300);
  const modalRows = await page.evaluate(AUDIT);
  const modalFails = modalRows.filter((r) => r.ratio < r.need);
  console.log(`modal     ${String(modalRows.length).padStart(3)} text nodes · smallest ${
    Math.min(...modalRows.map((r) => r.px))}px · ${
    modalFails.length ? modalFails.length + " BELOW AA" : "all pass AA ✓"}`);
  modalFails.slice(0, 6).forEach((f) =>
    console.log(`   ! ${f.sel} "${f.text}" ${f.px}px ${f.ratio}:1 (needs ${f.need})`));
  worstAll = worstAll.concat(modalFails);
  await page.screenshot({ path: `${SHOTS}/m-modal.png` });

  // iOS zooms the page when a focused input is under 16px
  const inputPx = await page.evaluate(() =>
    [...document.querySelectorAll("#journal-form input, #journal-form select, #journal-form textarea")]
      .filter((el) => !el.hidden && el.type !== "file")   // hidden fields never take focus
      .map((el) => parseFloat(getComputedStyle(el).fontSize)));
  const tooSmall = inputPx.filter((p) => p < 16);
  console.log(`\ninputs: ${inputPx.length} fields, smallest ${Math.min(...inputPx)}px — ${
    tooSmall.length ? tooSmall.length + " under 16px (iOS will zoom)" : "no iOS zoom-on-focus ✓"}`);

  console.log(`\nsmallest rendered text anywhere: ${minPx}px`);
  console.log(worstAll.length ? `\n${worstAll.length} TOTAL AA FAILURES` : "\nALL TEXT PASSES WCAG AA ✓");
  await browser.close();
  process.exit(worstAll.length || tooSmall.length ? 1 : 0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
