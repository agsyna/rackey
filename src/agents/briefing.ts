import "dotenv/config";
import { createHash } from "node:crypto";
import { execTool } from "../swytchcode.js";
import { alreadySent, markSent } from "../noteLedger.js";
import { completeText } from "../llm.js";
import type { CallLog } from "./email.js";
import type { BrokenPromise, Conflict, DailyBriefing, TriagedEmail } from "../types.js";

const FROM = process.env.BRIEFING_FROM || "onboarding@resend.dev";
const TO = process.env.BRIEFING_TO ?? "";

function idempotencyKey(subject: string, html: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `rackey-${createHash("sha1").update(`${day}|${subject}|${html}`).digest("hex").slice(0, 24)}`;
}

async function send(subject: string, html: string): Promise<{ id?: string; calls: CallLog[]; deduped: boolean }> {
  if (!TO) throw new Error("BRIEFING_TO is not set — add a destination address to .env");

  const key = idempotencyKey(subject, html);
  if (await alreadySent(key)) return { calls: [], deduped: true };

  const res = await execTool<{ id?: string }>("briefing", "resend.email.create", {
    headers: { "Idempotency-Key": key },
    body: { from: FROM, to: [TO], subject, html },
  });

  const calls: CallLog[] = [
    { agent: "briefing", tool: "resend.email.create", ok: res.ok, ms: res.durationMs },
  ];
  if (!res.ok) throw new Error(`Send failed: ${res.error?.message}`);

  await markSent(key, res.data?.id);
  return { id: res.data?.id, calls, deduped: false };
}

export async function sendReminder(promise: BrokenPromise) {
  const subject = `Reminder: ${promise.commitment}`.slice(0, 120);
  const html = `
    <h2>Unscheduled commitment</h2>
    <p><strong>You promised:</strong> ${escapeHtml(promise.commitment)}</p>
    <p><strong>To:</strong> ${escapeHtml(promise.madeToWhom)}</p>
    <p><strong>Deadline:</strong> ${escapeHtml(promise.impliedDeadline ?? "none stated")}</p>
    <p><strong>Why this was flagged:</strong> ${escapeHtml(promise.evidence)}</p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555">${escapeHtml(promise.sourceSnippet)}</blockquote>
    <p><strong>Suggested next step:</strong> ${escapeHtml(promise.suggestedAction)}</p>`;
  return send(subject, html);
}

export async function compileDailyBriefing(
  triaged: TriagedEmail[],
  conflicts: Conflict[],
  brokenPromises: BrokenPromise[],
): Promise<DailyBriefing> {
  const topEmails = triaged.slice(0, 3);

  const facts = [
    `Top emails: ${topEmails.map((e) => `"${e.subject}" from ${e.from} (${e.urgency}) — ${e.reason}`).join("; ") || "none"}`,
    `Schedule conflicts: ${conflicts.map((c) => `"${c.a.summary}" overlaps "${c.b.summary}" by ${c.overlapMinutes} min`).join("; ") || "none"}`,
    `Unscheduled commitments: ${brokenPromises.map((p) => `${p.commitment} (to ${p.madeToWhom}${p.impliedDeadline ? `, due ${p.impliedDeadline}` : ""})`).join("; ") || "none"}`,
  ].join("\n");

  let summary: string;
  try {
    summary = await completeText(
      "You write a short daily briefing for a busy executive. Two or three sentences, plain prose, no headings, no bullet points. Use only the facts given — never add anything not stated. If a section is empty, say so briefly rather than inventing content.",
      facts,
      400,
    );
  } catch {
    summary = `${topEmails.length} priority email(s), ${conflicts.length} schedule conflict(s), ${brokenPromises.length} unscheduled commitment(s).`;
  }

  return { generatedAt: new Date().toISOString(), topEmails, conflicts, brokenPromises, summary };
}

export async function sendDailyBriefing(briefing: DailyBriefing) {
  const section = (title: string, items: string[]) =>
    `<h3>${title}</h3>${items.length ? `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>` : "<p>Nothing flagged.</p>"}`;

  const html = `
    <p>${escapeHtml(briefing.summary)}</p>
    ${section(
      "Priority emails",
      briefing.topEmails.map(
        (e) => `<strong>${escapeHtml(e.subject)}</strong> — ${escapeHtml(e.from)} (${e.urgency})<br><em>${escapeHtml(e.reason)}</em>`,
      ),
    )}
    ${section(
      "Schedule conflicts",
      briefing.conflicts.map(
        (c) => `"${escapeHtml(c.a.summary)}" overlaps "${escapeHtml(c.b.summary)}" by ${c.overlapMinutes} min${c.proposedResolution ? `<br><em>${escapeHtml(c.proposedResolution)}</em>` : ""}`,
      ),
    )}
    ${section(
      "Unscheduled commitments",
      briefing.brokenPromises.map(
        (p) => `${escapeHtml(p.commitment)} — to ${escapeHtml(p.madeToWhom)}${p.impliedDeadline ? ` (due ${p.impliedDeadline})` : ""}`,
      ),
    )}
    <hr><p style="color:#888;font-size:12px">Rackey — generated ${escapeHtml(briefing.generatedAt)}</p>`;

  return send(`Daily briefing — ${briefing.generatedAt.slice(0, 10)}`, html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
