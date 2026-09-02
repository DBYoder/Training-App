/* Outbound email, with a pluggable transport chosen by MAIL_PROVIDER:
 *
 *   resend   POST to the Resend API (RESEND_API_KEY, MAIL_FROM). No deps.
 *   capture  append messages as JSON lines to MAIL_CAPTURE_FILE (tests).
 *   console  (default) log the message — including the link — to stdout.
 *
 * The console default matters: with no provider configured the app still
 * works, and an operator can recover an account by reading the server log
 * instead of hand-editing JSON on the volume. isConfigured() reports whether
 * mail can actually reach a user, which gates whether email verification is
 * enforced.
 */
"use strict";

const fs = require("fs");

function provider() {
  const explicit = (process.env.MAIL_PROVIDER || "").toLowerCase();
  if (explicit) return explicit;
  if (process.env.RESEND_API_KEY) return "resend";
  return "console";
}

/** True when mail actually reaches a real inbox. */
function isConfigured() {
  return provider() === "resend" && Boolean(process.env.RESEND_API_KEY);
}

function from() {
  return process.env.MAIL_FROM || "Marathon Trainer <onboarding@resend.dev>";
}

async function send({ to, subject, text }) {
  const p = provider();
  if (p === "capture") {
    const file = process.env.MAIL_CAPTURE_FILE;
    if (!file) throw new Error("MAIL_CAPTURE_FILE must be set for the capture provider");
    fs.appendFileSync(file, JSON.stringify({ to, subject, text, at: new Date().toISOString() }) + "\n");
    return { ok: true, provider: p };
  }
  if (p === "resend") {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: from(), to: [to], subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`resend ${res.status}: ${body.slice(0, 200)}`);
    }
    return { ok: true, provider: p };
  }
  // console: never throws, so a missing provider can't break a signup
  console.log(`[mail:console] to=${to} subject=${JSON.stringify(subject)}\n${text}\n`);
  return { ok: true, provider: "console" };
}

module.exports = { send, isConfigured, provider };
