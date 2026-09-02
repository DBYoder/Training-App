/* Training-plan parser: turns an uploaded file into the app's internal plan
 * shape { name, weeks: [{ days: [{ dow, type, title, details }] }] }.
 *
 * Two supported formats:
 *  1. Markdown table — one row per week, one column per day (the format of
 *     the original SWAP plan file). Day types are classified heuristically.
 *  2. JSON — the internal shape, documented in docs/plan-format.md.
 *
 * All uploaded text is HTML-escaped here; only markdown links [text](https://…)
 * become anchors, so plan details are safe to inject as HTML.
 */
"use strict";

(function (exportsTarget) {
  const DAY_TYPES = ["rest", "easy", "workout", "long", "race"];
  const TYPE_TITLES = {
    rest: "Rest day", easy: "Easy run", workout: "Workout",
    long: "Long run", race: "Race",
  };
  const MAX_WEEKS = 60;
  const MAX_DAYS_PER_WEEK = 14;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // after escaping, convert markdown links with http(s) URLs into anchors
  function linkify(escapedText) {
    return escapedText.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`
    );
  }

  // structured reps like "10 x 800" or "6 x 5 min" mark a workout, but
  // short strides/hills ("6 x 20 seconds") are easy-day garnish
  const HARD_REPS = /\d\s*[x×]\s*\d+(?![\d\s]*sec)/;
  // words that mean THIS day has structured work (used to veto "easy")
  const STRUCTURED_WORK = /warm(ing)?[- ]?up|tempo|interval|repeats|fartlek|threshold/;
  // broader hints used to positively tag a workout ("time trials"/"workouts"
  // also show up in easy-day side notes, so they can't veto "easy")
  const WORKOUT_HINTS = /time trial|workout/;

  function classifyDay(text, isLastDayOfPlan) {
    const t = text.toLowerCase();
    if (/^\s*rest\b/.test(t)) return "rest";
    const range = t.match(/^\s*(\d+)\s*[-–]\s*\d+\s*mi/);
    if (range && Number(range[1]) >= 12) return "long";
    // an easy run (possibly with short strides/hills) and no structured work
    if (/\b\d+(\s*[-–]\s*\d+)?\s*mi\s+(very\s+)?easy\b/.test(t) &&
        !STRUCTURED_WORK.test(t) && !HARD_REPS.test(t)) {
      return "easy";
    }
    if (/race day|goal race|\bmarathon\s*!/.test(t)) return "race";
    if (isLastDayOfPlan && /\b(marathon|race|10k|5k|half)\b/.test(t)) return "race";
    if (STRUCTURED_WORK.test(t) || HARD_REPS.test(t) || WORKOUT_HINTS.test(t)) return "workout";
    if (/long run/.test(t)) return "long";
    return "easy";
  }

  function titleFrom(text) {
    const firstSentence = text.split(/(?<=[.!?])\s+/)[0] || text;
    const t = firstSentence.trim().replace(/[.\s]+$/, "");
    return t.length > 72 ? `${t.slice(0, 69).trim()}…` : t;
  }

  const PIPE_SENTINEL = "\\u0001";

  function splitTableRow(line) {
    // split on unescaped pipes, drop the leading/trailing empties
    const cells = line.replace(/\\\|/g, PIPE_SENTINEL).split("|")
      .map((c) => c.split(PIPE_SENTINEL).join("|").trim());
    if (cells.length && cells[0] === "") cells.shift();
    if (cells.length && cells[cells.length - 1] === "") cells.pop();
    return cells;
  }

  function isSeparatorRow(cells) {
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "");
  }

  function cleanCell(text) {
    return text
      .replace(/\\([!*_#[\]()`])/g, "$1") // unescape markdown escapes like \!
      .replace(/\*\*([^*]+)\*\*/g, "$1")  // strip bold markers
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseMarkdownPlan(text, fallbackName) {
    const lines = text.split(/\r?\n/);
    const tableLines = [];
    let name = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|")) {
        tableLines.push(trimmed);
      } else if (!name && trimmed) {
        const candidate = cleanCell(trimmed);
        if (candidate) name = candidate;
      }
    }
    if (tableLines.length < 2) {
      throw new Error("No table found. Markdown plans need a table with one row per week and one column per day.");
    }

    const header = splitTableRow(tableLines[0]);
    const dayHeaders = header.slice(1).filter((h) => h !== "");
    if (dayHeaders.length < 2 || dayHeaders.length > MAX_DAYS_PER_WEEK) {
      throw new Error(`Expected 2–${MAX_DAYS_PER_WEEK} day columns in the table header, found ${dayHeaders.length}.`);
    }

    const weekRows = [];
    for (const line of tableLines.slice(1)) {
      const cells = splitTableRow(line);
      if (isSeparatorRow(cells)) continue;
      weekRows.push(cells);
    }
    if (!weekRows.length) throw new Error("The table has a header but no week rows.");
    if (weekRows.length > MAX_WEEKS) throw new Error(`Too many weeks (max ${MAX_WEEKS}).`);

    const weeks = buildWeeksFromCells(
      weekRows.map((cells) => cells.slice(1)), dayHeaders);
    return { name: name || fallbackName, weeks, dayHeaders, htmlDetails: true };
  }

  /* rows: [[cellText per day]] — shared by the markdown and PDF paths.
   *
   * `types` is an optional parallel grid of explicit day types. Classification
   * is a heuristic and gets a small number of days wrong, so anything the
   * runner has pinned in the builder wins outright; a null/absent entry means
   * "detect it". A pinned type applies to a blank cell too, so a day can be
   * marked as something other than rest without inventing text for it. */
  function buildWeeksFromCells(rows, dayHeaders, types) {
    const pinned = (wi, di) => {
      const t = types && types[wi] && types[wi][di];
      return DAY_TYPES.includes(t) ? t : null;
    };
    return rows.map((cells, wi) => {
      const days = dayHeaders.map((dow, di) => {
        const raw = cleanCell(cells[di] || "");
        const isLastDay = wi === rows.length - 1 && di === dayHeaders.length - 1;
        const override = pinned(wi, di);
        if (!raw) {
          return override && override !== "rest"
            ? { dow, type: override, title: TYPE_TITLES[override], details: [TYPE_TITLES[override] + "."] }
            : { dow, type: "rest", title: "Rest day", details: ["Rest."] };
        }
        return {
          dow,
          type: override || classifyDay(raw, isLastDay),
          title: escapeHtml(titleFrom(raw)),
          details: [linkify(escapeHtml(raw))],
        };
      });
      return { days };
    });
  }

  /* ----- PDF plans -----
   * Input: per-page positioned text items extracted with pdf.js
   * (pages: [{items: [{x, y, str}]}], y in PDF coordinates, bottom-up).
   * Reconstructs a week × day grid: the line containing several weekday
   * names gives the column x-positions; "Week N" labels (or any text in
   * the left gutter) start new rows; every other item lands in the column
   * band its x falls into. Works for grid-style plan PDFs (a table per
   * page, rows may continue across pages).
   */
  const WEEKDAY_NAMES = /^(mon|tue(s)?|wed(nesday)?|thu(rs)?|fri|sat(urday)?|sun)(day)?\.?$/i;

  function groupLines(items) {
    const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const item of sorted) {
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - item.y) <= 3) {
        line.items.push(item);
      } else {
        lines.push({ y: item.y, items: [item] });
      }
    }
    for (const line of lines) line.items.sort((a, b) => a.x - b.x);
    return lines;
  }

  function parsePdfItems(pages, fallbackName) {
    const pageLines = pages.map((p) =>
      groupLines((p.items || []).filter((i) => i.str && i.str.trim())));

    // locate the header line: 3+ weekday tokens on one line
    let headerCols = null;
    let headerPage = -1;
    let headerY = 0;
    outer:
    for (let pi = 0; pi < pageLines.length; pi++) {
      for (const line of pageLines[pi]) {
        const dayItems = line.items.filter((i) => WEEKDAY_NAMES.test(i.str.trim()));
        if (dayItems.length >= 3) {
          headerCols = dayItems.map((i) => ({ x: i.x, label: i.str.trim().slice(0, 3) }));
          headerPage = pi;
          headerY = line.y;
          break outer;
        }
      }
    }
    if (!headerCols) {
      throw new Error("Couldn't find a weekday header row (Mon/Tue/…) in the PDF. PDF import works for grid-style plans — one row per week, one column per day. You can also paste the plan as a markdown table.");
    }

    // the "Week N" gutter can be much narrower than the day columns, so
    // locate it from the week labels themselves: items matching "Week N"
    // that sit left of the first day column's text
    const xs = headerCols.map((c) => c.x);
    const anchorXs = [];
    for (const lines of pageLines) {
      for (const line of lines) {
        for (const item of line.items) {
          if (/^week\s*\d+/i.test(item.str.trim()) && item.x < xs[0] - 2) {
            anchorXs.push(item.x);
          }
        }
      }
    }
    if (!anchorXs.length) {
      throw new Error('No week rows found — expected "Week 1", "Week 2", … labels in the first column of the PDF table.');
    }
    const leftEdge = (Math.max(...anchorXs) + xs[0]) / 2;
    const boundaries = xs.map((x, i) => (i === 0 ? leftEdge : (xs[i - 1] + xs[i]) / 2));
    const colFor = (x) => {
      if (x < leftEdge) return -1; // gutter
      let col = 0;
      for (let i = boundaries.length - 1; i >= 0; i--) {
        if (x >= boundaries[i]) { col = i; break; }
      }
      return col;
    };

    const rows = []; // [{cells: [[strings]]}]
    let nameParts = [];
    for (let pi = 0; pi < pageLines.length; pi++) {
      for (const line of pageLines[pi]) {
        if (pi < headerPage || (pi === headerPage && line.y > headerY)) {
          // text above the table: treat as the plan title
          nameParts.push(line.items.map((i) => i.str).join(" "));
          continue;
        }
        if (pi === headerPage && Math.abs(line.y - headerY) <= 3) continue; // header itself
        const gutterItem = line.items.find((i) =>
          colFor(i.x) === -1 && /^week\s*\d*$/i.test(i.str.trim()));
        if (gutterItem) rows.push({ cells: headerCols.map(() => []) });
        if (!rows.length) continue; // stray text before the first week row
        const row = rows[rows.length - 1];
        for (const item of line.items) {
          const col = colFor(item.x);
          if (col >= 0) row.cells[col].push(item.str.trim());
        }
      }
    }
    if (!rows.length) {
      throw new Error('No week rows found — expected "Week 1", "Week 2", … labels in the first column of the PDF table.');
    }
    if (rows.length > MAX_WEEKS) throw new Error(`Too many weeks (max ${MAX_WEEKS}).`);

    const canonical = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
    const dayHeaders = headerCols.map((c) => canonical[c.label.toLowerCase()] || c.label);
    const weeks = buildWeeksFromCells(rows.map((r) => r.cells.map((c) => c.join(" "))), dayHeaders);
    const name = cleanCell(nameParts.join(" ")).slice(0, 120) || fallbackName;
    return { name: escapeHtml(name), weeks, dayHeaders, htmlDetails: true };
  }

  function parseJsonPlan(text, fallbackName) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error("The file is not valid JSON.");
    }
    if (!obj || typeof obj !== "object" || !Array.isArray(obj.weeks) || !obj.weeks.length) {
      throw new Error('JSON plans need a "weeks" array — see docs/plan-format.md.');
    }
    if (obj.weeks.length > MAX_WEEKS) throw new Error(`Too many weeks (max ${MAX_WEEKS}).`);

    const dpw = Array.isArray(obj.weeks[0].days) ? obj.weeks[0].days.length : 0;
    if (dpw < 1 || dpw > MAX_DAYS_PER_WEEK) {
      throw new Error(`Each week needs 1–${MAX_DAYS_PER_WEEK} days.`);
    }
    const defaultHeaders = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const dayHeaders = Array.isArray(obj.dayHeaders) && obj.dayHeaders.length === dpw
      ? obj.dayHeaders.map((h) => escapeHtml(String(h).slice(0, 12)))
      : Array.from({ length: dpw }, (_, i) => defaultHeaders[i] || `Day ${i + 1}`);

    const weeks = obj.weeks.map((w, wi) => {
      if (!Array.isArray(w.days) || w.days.length !== dpw) {
        throw new Error(`Week ${wi + 1} has ${(w.days || []).length} days; every week must have ${dpw}.`);
      }
      const days = w.days.map((d, di) => {
        if (!d || typeof d !== "object") throw new Error(`Week ${wi + 1}, day ${di + 1} is not an object.`);
        const detailsSrc = Array.isArray(d.details) ? d.details : (d.details ? [d.details] : []);
        const details = detailsSrc.map((p) => linkify(escapeHtml(String(p).slice(0, 4000))));
        const rawTitle = String(d.title || "").trim();
        const rawText = `${rawTitle} ${detailsSrc.join(" ")}`.trim() || "Rest.";
        const isLastDay = wi === obj.weeks.length - 1 && di === dpw - 1;
        return {
          dow: dayHeaders[di],
          type: DAY_TYPES.includes(d.type) ? d.type : classifyDay(rawText, isLastDay),
          title: escapeHtml(rawTitle ? titleFrom(rawTitle) : titleFrom(rawText)),
          details: details.length ? details : ["Rest."],
        };
      });
      return { days };
    });

    const name = obj.name ? escapeHtml(String(obj.name).slice(0, 120)) : fallbackName;
    return { name, weeks, dayHeaders, htmlDetails: true };
  }

  /* Build a plan from raw day-cell text entered in the in-app builder.
   * rows: [[cellText per day] per week]. Empty cells become rest days;
   * types/titles are classified the same way as uploaded plans, except where
   * `types` pins one explicitly. */
  function buildPlan(name, rows, dayHeaders, types) {
    const headers = (Array.isArray(dayHeaders) && dayHeaders.length
      ? dayHeaders
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    ).map((h) => escapeHtml(String(h).slice(0, 12)));
    if (headers.length < 1 || headers.length > MAX_DAYS_PER_WEEK) {
      throw new Error(`Weeks need 1–${MAX_DAYS_PER_WEEK} days.`);
    }
    if (!Array.isArray(rows) || !rows.length) throw new Error("Add at least one week.");
    if (rows.length > MAX_WEEKS) throw new Error(`Too many weeks (max ${MAX_WEEKS}).`);
    if (rows.every((r) => r.every((c) => !String(c || "").trim()))) {
      throw new Error("Every day is blank — write at least one workout.");
    }
    const cells = rows.map((r) => headers.map((_, i) => String(r[i] ?? "")));
    const weeks = buildWeeksFromCells(cells, headers, types);
    const cleanName = escapeHtml(String(name || "").trim().slice(0, 120)) || "My plan";
    return { name: cleanName, weeks, dayHeaders: headers, htmlDetails: true };
  }

  function parsePlanFile(filename, text) {
    const fallbackName = (filename || "Uploaded plan")
      .replace(/\.(md|markdown|json|txt)$/i, "")
      .replace(/[-_]+/g, " ")
      .trim() || "Uploaded plan";
    const trimmed = text.trim();
    if (/\.json$/i.test(filename || "") || trimmed.startsWith("{")) {
      return parseJsonPlan(trimmed, fallbackName);
    }
    return parseMarkdownPlan(trimmed, fallbackName);
  }

  exportsTarget.PlanParser = {
    parsePlanFile, parseMarkdownPlan, parseJsonPlan, parsePdfItems, buildPlan,
    escapeHtml, classifyDay, DAY_TYPES, TYPE_TITLES,
  };
})(typeof module !== "undefined" && module.exports ? module.exports : window);
