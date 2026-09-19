import { execTool } from "../swytchcode.js";
import { completeText } from "../llm.js";
import type { CalendarEvent, Conflict } from "../types.js";
import type { CallLog } from "./email.js";

interface GCalListResponse {
  items?: Array<{
    id: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    attendees?: Array<{ email?: string; self?: boolean }>;
  }>;
}

function domainOf(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export async function fetchEvents(days = 7): Promise<{ events: CalendarEvent[]; calls: CallLog[] }> {
  const now = new Date();
  const timeMin = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

  const res = await execTool<GCalListResponse>("calendar", "calendar.event.get", {
    inputs: { calendarId: "primary" },
    params: { timeMin, timeMax, singleEvents: true, orderBy: "startTime", maxResults: 100 },
  });

  const calls: CallLog[] = [
    { agent: "calendar", tool: "calendar.event.get", ok: res.ok, ms: res.durationMs },
  ];
  if (!res.ok) throw new Error(`Could not list events: ${res.error?.message}`);

  const items = res.data?.items ?? [];
  const selfDomain = domainOf(
    items.flatMap((i) => i.attendees ?? []).find((a) => a.self)?.email ?? "",
  );

  const events: CalendarEvent[] = [];
  for (const item of items) {
    const start = item.start?.dateTime ?? item.start?.date;
    const end = item.end?.dateTime ?? item.end?.date;
    if (!start || !end) continue;

    const attendees = (item.attendees ?? []).map((a) => a.email ?? "").filter(Boolean);
    events.push({
      id: item.id,
      summary: item.summary ?? "(untitled)",
      start,
      end,
      attendees,
      hasExternalAttendees: selfDomain
        ? attendees.some((a) => domainOf(a) && domainOf(a) !== selfDomain)
        : false,
    });
  }

  return { events, calls };
}

export function detectConflicts(events: CalendarEvent[]): Conflict[] {
  const timed = events
    .filter((e) => e.start.includes("T"))
    .map((e) => ({ event: e, from: Date.parse(e.start), to: Date.parse(e.end) }))
    .filter((e) => Number.isFinite(e.from) && Number.isFinite(e.to) && e.to > e.from)
    .sort((a, b) => a.from - b.from);

  const conflicts: Conflict[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].from >= timed[i].to) break;

      const overlapMs = Math.min(timed[i].to, timed[j].to) - timed[j].from;
      if (overlapMs > 0) {
        conflicts.push({
          a: timed[i].event,
          b: timed[j].event,
          overlapMinutes: Math.round(overlapMs / 60000),
        });
      }
    }
  }
  return conflicts;
}

export async function proposeResolution(conflict: Conflict): Promise<string> {
  const describe = (e: CalendarEvent) =>
    `"${e.summary}" (${e.attendees.length} attendee(s)${e.hasExternalAttendees ? ", includes external participants" : ", internal only"}, ${e.start} → ${e.end})`;

  try {
    return await completeText(
      "You advise an executive on scheduling. Reply with ONE sentence recommending which of the two meetings to move and why. Base the reason only on the attendee counts and external-participant flags given. Do not invent details. Do not offer to reschedule it yourself.",
      `These two meetings overlap by ${conflict.overlapMinutes} minutes:\nA: ${describe(conflict.a)}\nB: ${describe(conflict.b)}`,
      200,
    );
  } catch {
    const fewer = conflict.a.attendees.length <= conflict.b.attendees.length ? conflict.a : conflict.b;
    return `These overlap by ${conflict.overlapMinutes} minutes. "${fewer.summary}" has fewer attendees — likely the easier one to move.`;
  }
}
