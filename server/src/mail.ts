/**
 * Email: sign-in codes and team invitations, sent through Resend. Without a Resend key (local
 * development, tests) each message is kept in `outbox` and printed, so the code can be read there.
 */
import type { Config } from "./config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What was "sent" without Resend, newest last (tests read codes from here). */
export const outbox: Mail[] = [];

export function mailer(config: Config) {
  return async function send(m: Mail): Promise<void> {
    if (!config.mail) {
      outbox.push(m);
      if (outbox.length > 200) outbox.shift();
      if (!process.env.QUIET_MAIL) console.log(`[mail] to ${m.to}: ${m.subject}\n${m.text}`);
      return;
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.mail.resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: config.mail.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`Couldn't send the email (Resend answered ${r.status}).`);
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A plain, readable email: one heading, a few lines, an optional button or code. */
export function letter(o: { heading: string; lines: string[]; code?: string; button?: { label: string; url: string } }): { text: string; html: string } {
  const text = [o.heading, "", ...o.lines, ...(o.code ? ["", o.code] : []), ...(o.button ? ["", `${o.button.label}: ${o.button.url}`] : [])].join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a">
<div style="max-width:440px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;border:1px solid #e8e8e4">
<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;font-weight:600">${esc(o.heading)}</h1>
${o.lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px;color:#444">${esc(l)}</p>`).join("")}
${o.code ? `<p style="font-size:30px;letter-spacing:6px;font-weight:600;margin:20px 0 8px;font-family:ui-monospace,Menlo,monospace">${esc(o.code)}</p>` : ""}
${o.button ? `<p style="margin:24px 0 0"><a href="${esc(o.button.url)}" style="display:inline-block;background:#1a1a1a;color:#fff;text-decoration:none;font-size:15px;font-weight:500;padding:11px 18px;border-radius:8px">${esc(o.button.label)}</a></p>` : ""}
</div></body></html>`;
  return { text, html };
}
