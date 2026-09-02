/* Target-pace engine — Daniels/Gilbert VDOT model (the published equations
 * behind Daniels' Running Formula), not homemade heuristics.
 *
 *   VO2(v)      = -4.60 + 0.182258·v + 0.000104·v²        (v in m/min)
 *   %VO2max(t)  = 0.8 + 0.1894393·e^(-0.012778·t)
 *                     + 0.2989558·e^(-0.1932605·t)         (t in minutes)
 *   VDOT        = VO2 at race velocity ÷ %VO2max at race duration
 *
 * Zones come from their definitions: easy = 62–74 %VDOT (a real range);
 * M / 10k / 5k / 3k = equivalent-race paces solved numerically from the same
 * model; threshold = the pace of a 60-minute race — which is precisely the
 * SWAP plan's "1-hour effort".
 *
 * Validated in tests against known VDOT anchors (19:57 5k ⇒ VDOT ≈ 50 ⇒
 * marathon ≈ 3:10:49) and round-trip consistency. Works in browser and Node.
 */
"use strict";

(function (exportsTarget) {
  const METERS_PER_MILE = 1609.344;
  const RACE_DISTANCES = {
    "5k": 5000,
    "10k": 10000,
    half: 21097.5,
    marathon: 42195,
  };

  function vo2AtVelocity(v) {
    return -4.6 + 0.182258 * v + 0.000104 * v * v;
  }

  function fracVo2max(minutes) {
    return 0.8 +
      0.1894393 * Math.exp(-0.012778 * minutes) +
      0.2989558 * Math.exp(-0.1932605 * minutes);
  }

  function velocityAtVo2(vo2) {
    const a = 0.000104, b = 0.182258, c = -4.6 - vo2;
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a); // m/min
  }

  function vdotFromRace(meters, seconds) {
    if (!(meters > 0) || !(seconds > 0)) return null;
    const minutes = seconds / 60;
    const vdot = vo2AtVelocity(meters / minutes) / fracVo2max(minutes);
    // outside this band the model (and the input) can't be trusted
    return vdot >= 20 && vdot <= 90 ? vdot : null;
  }

  /* Equivalent race time (seconds) for a distance at a given VDOT.
   * impliedVdot(t) decreases as t grows, so bisect. */
  function equivalentRaceTime(vdot, meters) {
    let lo = 2, hi = 720; // minutes
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const implied = vo2AtVelocity(meters / mid) / fracVo2max(mid);
      if (implied > vdot) lo = mid;
      else hi = mid;
    }
    return ((lo + hi) / 2) * 60;
  }

  function paceFromVelocity(v) {
    return (METERS_PER_MILE / v) * 60; // sec per mile
  }

  /* All zone paces in seconds per mile. */
  function trainingPaces(vdot) {
    const racePace = (meters) => equivalentRaceTime(vdot, meters) / (meters / METERS_PER_MILE);
    return {
      easyFast: paceFromVelocity(velocityAtVo2(vdot * 0.74)),
      easySlow: paceFromVelocity(velocityAtVo2(vdot * 0.62)),
      M: racePace(RACE_DISTANCES.marathon),
      T: paceFromVelocity(velocityAtVo2(vdot * fracVo2max(60))), // 60-min race = "1-hour effort"
      tenK: racePace(RACE_DISTANCES["10k"]),
      fiveK: racePace(RACE_DISTANCES["5k"]),
      threeK: racePace(3000),
    };
  }

  function formatPaceSec(secPerMile) {
    const m = Math.floor(secPerMile / 60);
    const s = Math.round(secPerMile % 60);
    return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatClock(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  /* ----- duration entry -----
   * Phone keypads (inputmode=numeric) have no colon, so the field masks
   * digits into hh:mm:ss as they are typed — exactly like a stopwatch,
   * filling from the right:
   *
   *   4       -> "4"          (4 seconds)
   *   45      -> "45"
   *   123     -> "1:23"
   *   4530    -> "45:30"
   *   012133  -> "01:21:33"
   *
   * What you see is what gets saved, so there is no hidden rule to remember.
   * Typed colons are still accepted for anyone on a full keyboard.
   */
  const MAX_DURATION_SEC = 24 * 3600;

  /** Live input mask: digits in, hh:mm:ss out. */
  function maskDuration(text) {
    const d = String(text ?? "").replace(/\D/g, "").slice(0, 6);
    if (d.length <= 2) return d;
    if (d.length <= 4) return `${d.slice(0, -2)}:${d.slice(-2)}`;
    return `${d.slice(0, -4)}:${d.slice(-4, -2)}:${d.slice(-2)}`;
  }

  function parseDuration(text) {
    if (text === null || text === undefined) return null;
    const raw = String(text).trim();
    if (!raw) return null;
    // masking strips stray characters, so validate before relying on it —
    // "4530x" must be refused, not quietly read as 45:30
    if (!raw.includes(":") && !/^\d+$/.test(raw)) return null;
    // bare digits mean the same as the mask would show for them
    const normalized = raw.includes(":") ? raw : maskDuration(raw);

    const parts = normalized.split(":").map((p) => p.trim());
    if (parts.some((p) => p === "" || !/^\d+$/.test(p))) return null;
    const n = parts.map(Number);
    let h = 0, m = 0, sec = 0;
    if (n.length === 3) [h, m, sec] = n;
    else if (n.length === 2) [m, sec] = n;
    else if (n.length === 1) [sec] = n;      // "45" is 45 seconds, as displayed
    else return null;

    // only the leading field may exceed 59 ("90:00" is a valid 90 minutes)
    if (n.length === 3 && (m > 59 || sec > 59)) return null;
    if (n.length === 2 && sec > 59) return null;
    if (n.length === 1 && sec > 59) return null;

    const total = h * 3600 + m * 60 + sec;
    // a typo like "45300" would otherwise sail through as a 12-hour run
    return total > 0 && total <= MAX_DURATION_SEC ? total : null;
  }

  /** Canonical h:mm:ss / m:ss for echoing back what was understood. */
  function normalizeDuration(text) {
    const secs = parseDuration(text);
    return secs === null ? null : formatClock(secs);
  }

  exportsTarget.PaceEngine = {
    parseDuration,
    normalizeDuration,
    maskDuration,
    MAX_DURATION_SEC,
    RACE_DISTANCES,
    vdotFromRace,
    equivalentRaceTime,
    trainingPaces,
    formatPaceSec,
    formatClock,
  };
})(typeof module !== "undefined" && module.exports ? module.exports : window);
