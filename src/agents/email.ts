import { execTool } from "../swytchcode.js";
import { completeJSON } from "../llm.js";
import type { Commitment, Email, TriagedEmail } from "../types.js";

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
}

interface GmailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPart;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

function header(msg: GmailMessage, name: string): string {
  const found = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found?.value ?? "";
}

function extractBody(part: GmailPart | undefined, depth = 0): string {
  if (!part || depth > 8) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url").toString("utf8");
  }

  for (const child of part.parts ?? []) {
    const text = extractBody(child, depth + 1);
    if (text) return text;
  }

  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64url")
      .toString("utf8")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  }
  return "";
}

export async function fetchEmails(limit = 8): Promise<{ emails: Email[]; calls: CallLog[] }> {
  const calls: CallLog[] = [];

  const list = await execTool<GmailListResponse>("email", "gmail.user.messages.get", {
    inputs: { userId: "me" },
    params: { maxResults: limit, q: "in:inbox" },
  });
  calls.push({ agent: "email", tool: "gmail.user.messages.get", ok: list.ok, ms: list.durationMs });

  if (!list.ok) throw new Error(`Could not list messages: ${list.error?.message}`);

  const ids = (list.data?.messages ?? []).slice(0, limit);

  const CONCURRENCY = 5;
  let cursor = 0;
  const fetched: Array<Email | null> = new Array(ids.length).fill(null);

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= ids.length) return;

        const fetchOne = () =>
          execTool<GmailMessage>("email", "gmail.user.messages.get1", {
            inputs: { userId: "me", id: ids[index].id },
            params: { format: "full" },
          });

        let one = await fetchOne();
        if (!one.ok && one.error?.category === "auth") {
          one = await fetchOne();
        }
        calls.push({ agent: "email", tool: "gmail.user.messages.get1", ok: one.ok, ms: one.durationMs });
        if (!one.ok || !one.data) continue;

        const msg = one.data;
        fetched[index] = {
          id: msg.id,
          threadId: msg.threadId,
          from: header(msg, "From"),
          to: header(msg, "To"),
          subject: header(msg, "Subject") || "(no subject)",
          date: header(msg, "Date"),
          body: extractBody(msg.payload).slice(0, 700),
          snippet: msg.snippet ?? "",
        };
      }
    }),
  );

  return { emails: fetched.filter((e): e is Email => e !== null), calls };
}

export interface CallLog {
  agent: string;
  tool: string;
  ok: boolean;
  ms: number;
}

const TRIAGE_SYSTEM = `You triage an executive's inbox. You return JSON only.

Return this exact shape:
{
  "triaged": [
    {"id": "<email id>", "urgency": "high"|"medium"|"low",
     "reason": "<one sentence, why this urgency>",
     "sourceSnippet": "<VERBATIM quote from that email's text supporting the reason>"}
  ],
  "commitments": [
    {"sourceEmailId": "<email id>", "text": "<the promise, as stated>",
     "madeToWhom": "<person or team>", "impliedDeadline": "<YYYY-MM-DD or null>",
     "sourceSnippet": "<VERBATIM quote containing the promise>"}
  ]
}

Rules you must not break:
- Return exactly one "triaged" entry for EVERY email you were given — no omissions. An email that is routine gets urgency "low"; it does not get left out. If you were given 15 emails, "triaged" has 15 entries.
- Every sourceSnippet must be copied character-for-character from the email text you were given. Never paraphrase it, never invent it.
- A commitment is something the ACCOUNT OWNER promised to do ("I'll send...", "I will get you...", "I'm going to have that over by..."). Requests made OF the owner are not commitments.
- impliedDeadline must be null unless the text states a date or a resolvable phrase like "by Friday". Never guess a date.

How to rank. Judge the CONSEQUENCE OF DELAY, never the sender's tone or their own urgency claims. Capital letters, "URGENT", and red flags count for nothing on their own.

high — a deadline falls within roughly 48 hours, money or legal exposure is at stake, account access or security is affected, or a named person is blocked waiting on this reply.
medium — a real obligation with a deadline further out, or a decision that is genuinely the owner's to make but is not time-critical today.
low — informational, automated, promotional, or something no one is waiting on. Most notification mail is low even when it is styled to look urgent.

Two tie-breakers: a message addressed personally to the owner outranks one sent to a list, and a message that asks a direct question outranks one that merely reports something.`;

export async function triageEmails(
  emails: Email[],
): Promise<{ triaged: TriagedEmail[]; commitments: Commitment[] }> {
  if (emails.length === 0) return { triaged: [], commitments: [] };

  const corpus = emails
    .map((e) => `--- EMAIL id=${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n\n${(e.body || e.snippet).slice(0, 600)}`)
    .join("\n\n");

  const raw = await completeJSON<{
    triaged?: Array<Partial<TriagedEmail> & { id?: string }>;
    commitments?: Array<Partial<Commitment>>;
  }>(TRIAGE_SYSTEM, corpus);

  const byId = new Map(emails.map((e) => [e.id, e]));
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

  const triaged: TriagedEmail[] = [];
  for (const item of raw.triaged ?? []) {
    const email = item.id ? byId.get(item.id) : undefined;
    if (!email || !item.reason) continue;

    const haystack = flat(`${email.body} ${email.snippet} ${email.subject}`);
    const quoted = item.sourceSnippet ?? "";
    const verified = quoted.length > 0 && haystack.includes(flat(quoted));

    triaged.push({
      id: email.id,
      subject: email.subject,
      from: email.from,
      urgency: item.urgency === "high" || item.urgency === "medium" ? item.urgency : "low",
      reason: item.reason,
      sourceSnippet: verified ? quoted : (email.snippet || email.subject).slice(0, 240),
    });
  }

  const commitments: Commitment[] = [];
  for (const item of raw.commitments ?? []) {
    const email = item.sourceEmailId ? byId.get(item.sourceEmailId) : undefined;
    if (!email || !item.text || !item.sourceSnippet) continue;

    const haystack = flat(`${email.body} ${email.snippet}`);
    if (!haystack.includes(flat(item.sourceSnippet))) continue;

    commitments.push({
      text: item.text,
      madeToWhom: item.madeToWhom ?? "unknown",
      impliedDeadline: /^\d{4}-\d{2}-\d{2}$/.test(String(item.impliedDeadline))
        ? String(item.impliedDeadline)
        : null,
      sourceEmailId: email.id,
      sourceSnippet: item.sourceSnippet,
    });
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  triaged.sort((a, b) => order[a.urgency] - order[b.urgency]);

  return { triaged, commitments };
}
