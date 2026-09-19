import { detectConflicts, fetchEvents, proposeResolution } from "./agents/calendar.js";
import { fetchEmails, triageEmails, type CallLog } from "./agents/email.js";
import { suggestNoteForPromise, writeNote } from "./agents/notes.js";
import { compileDailyBriefing, sendDailyBriefing, sendReminder } from "./agents/briefing.js";
import { commitmentKey, detectBrokenPromises } from "./detectors/brokenPromises.js";
import { notedKeys } from "./noteLedger.js";
import { ScopeViolationError } from "./scopes.js";
import { ScopeDriftError } from "./swytchcode.js";
import type { ActionResult, BrokenPromise } from "./types.js";

export type Action =
  | "triage"
  | "conflicts"
  | "promises"
  | "addNote"
  | "sendReminder"
  | "dailyBriefing";

export const WRITE_ACTIONS: ReadonlySet<Action> = new Set(["addNote", "sendReminder", "dailyBriefing"]);

async function run<T>(action: Action, fn: (calls: CallLog[]) => Promise<T>): Promise<ActionResult<T>> {
  const calls: CallLog[] = [];
  try {
    const data = await fn(calls);
    return { ok: true, action, data, calls };
  } catch (err) {
    const error =
      err instanceof ScopeViolationError || err instanceof ScopeDriftError
        ? `${err.name}: ${err.message}`
        : (err as Error).message;
    return { ok: false, action, error, calls };
  }
}

export function runTriage() {
  return run("triage", async (calls) => {
    const { emails, calls: c } = await fetchEmails();
    calls.push(...c);
    const { triaged, commitments } = await triageEmails(emails);
    return { triaged, commitments, emailCount: emails.length };
  });
}

export function runConflicts() {
  return run("conflicts", async (calls) => {
    const { events, calls: c } = await fetchEvents();
    calls.push(...c);
    const conflicts = detectConflicts(events);
    for (const conflict of conflicts) {
      conflict.proposedResolution = await proposeResolution(conflict);
    }
    return { conflicts, eventCount: events.length };
  });
}

export function runBrokenPromises() {
  return run("promises", async (calls) => {
    const [emailSide, calendarSide] = await Promise.all([fetchEmails(), fetchEvents()]);
    calls.push(...emailSide.calls, ...calendarSide.calls);

    const { commitments, triaged } = await triageEmails(emailSide.emails);
    const promises = detectBrokenPromises(commitments, calendarSide.events, {
      alreadyNoted: await notedKeys(),
    });

    return {
      brokenPromises: promises,
      suggestedNotes: promises.map((p) => ({ key: p.key, ...suggestNoteForPromise(p) })),
      commitmentsFound: commitments.length,
      emailsRead: emailSide.emails.length,
      triaged,
    };
  });
}

export function runAddNote(input: { title: string; body: string; key?: string }) {
  return run("addNote", async (calls) => {
    const { pageId, calls: c } = await writeNote(input);
    calls.push(...c);
    return { pageId };
  });
}

export function runSendReminder(promise: BrokenPromise) {
  return run("sendReminder", async (calls) => {
    const withKey: BrokenPromise = {
      ...promise,
      key: promise.key || commitmentKey({
        text: promise.commitment,
        madeToWhom: promise.madeToWhom,
        impliedDeadline: promise.impliedDeadline,
        sourceEmailId: promise.sourceEmailId,
        sourceSnippet: promise.sourceSnippet,
      }),
    };
    const { id, calls: c, deduped } = await sendReminder(withKey);
    calls.push(...c);
    return { id, deduped };
  });
}

export function runDailyBriefing() {
  return run("dailyBriefing", async (calls) => {
    const [emailSide, calendarSide] = await Promise.all([fetchEmails(), fetchEvents()]);
    calls.push(...emailSide.calls, ...calendarSide.calls);

    const { triaged, commitments } = await triageEmails(emailSide.emails);
    const conflicts = detectConflicts(calendarSide.events);
    for (const conflict of conflicts) {
      conflict.proposedResolution = await proposeResolution(conflict);
    }
    const promises = detectBrokenPromises(commitments, calendarSide.events, {
      alreadyNoted: await notedKeys(),
    });

    const briefing = await compileDailyBriefing(triaged, conflicts, promises);
    const { id, calls: c, deduped } = await sendDailyBriefing(briefing);
    calls.push(...c);
    return { briefing, id, deduped };
  });
}
