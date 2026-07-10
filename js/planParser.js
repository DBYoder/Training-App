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

    const weeks = weekRows.map((cells, wi) => {
      const days = dayHeaders.map((dow, di) => {
        const raw = cleanCell(cells[di + 1] || "");
        const isLastDay = wi === weekRows.length - 1 && di === dayHeaders.length - 1;
        if (!raw) {
          return { dow, type: "rest", title: "Rest day", details: ["Rest."] };
        }
        return {
          dow,
          type: classifyDay(raw, isLastDay),
          title: escapeHtml(titleFrom(raw)),
          details: [linkify(escapeHtml(raw))],
        };
      });
      return { days };
    });

    return { name: name || fallbackName, weeks, dayHeaders, htmlDetails: true };
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

  exportsTarget.PlanParser = { parsePlanFile, parseMarkdownPlan, parseJsonPlan, escapeHtml };
})(typeof module !== "undefined" && module.exports ? module.exports : window);
