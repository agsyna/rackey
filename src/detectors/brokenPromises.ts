import { createHash } from "node:crypto";
import type { BrokenPromise, CalendarEvent, Commitment } from "../types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "for", "of", "in", "on", "at", "by",
  "with", "from", "up", "about", "into", "over", "after", "you", "your", "i", "we",
  "will", "ill", "send", "get", "have", "that", "this", "it", "is", "be", "am", "are",
  "them", "then", "so", "as", "my", "me", "our", "out", "can", "do", "done", "next",
  "week", "day", "today", "tomorrow", "monday", "tuesday", "wednesday", "thursday",
  "friday", "saturday", "sunday", "asap", "soon", "some", "any", "all", "just",
]);

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w)),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hits = 0;
  for (const word of a) if (b.has(word)) hits++;
  return hits / a.size;
}

export function commitmentKey(c: Commitment): string {
  return createHash("sha1")
    .update(`${c.sourceEmailId}|${c.text.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 12);
}

const MATCH_THRESHOLD = 0.34;

export interface DetectOptions {
  alreadyNoted?: Set<string>;
}

export function detectBrokenPromises(
  commitments: Commitment[],
  events: CalendarEvent[],
  options: DetectOptions = {},
): BrokenPromise[] {
  const alreadyNoted = options.alreadyNoted ?? new Set<string>();

  const eventTerms = events.map((e) => ({
    event: e,
    terms: keywords(`${e.summary} ${e.attendees.join(" ")}`),
  }));

  const broken: BrokenPromise[] = [];

  for (const commitment of commitments) {
    const key = commitmentKey(commitment);
    if (alreadyNoted.has(key)) continue;

    const terms = keywords(`${commitment.text} ${commitment.madeToWhom}`);

    let best: { summary: string; score: number } | null = null;
    for (const candidate of eventTerms) {
      const score = overlapScore(terms, candidate.terms);
      if (!best || score > best.score) best = { summary: candidate.event.summary, score };
    }

    if (best && best.score >= MATCH_THRESHOLD) continue;

    const evidence =
      events.length === 0
        ? "No calendar events were found in the window checked."
        : best && best.score > 0
          ? `Nothing on the calendar corresponds to it; the closest match ("${best.summary}") shares too little with the commitment to count.`
          : `None of the ${events.length} calendar events in the window mention this.`;

    broken.push({
      commitment: commitment.text,
      madeToWhom: commitment.madeToWhom,
      impliedDeadline: commitment.impliedDeadline,
      status: "unscheduled",
      evidence,
      suggestedAction: commitment.impliedDeadline
        ? `Block time before ${commitment.impliedDeadline}, or tell ${commitment.madeToWhom} it will be late.`
        : `Schedule time for this, or confirm a date with ${commitment.madeToWhom}.`,
      sourceEmailId: commitment.sourceEmailId,
      sourceSnippet: commitment.sourceSnippet,
      key,
    });
  }

  return broken.sort((a, b) => {
    if (a.impliedDeadline && b.impliedDeadline) return a.impliedDeadline.localeCompare(b.impliedDeadline);
    if (a.impliedDeadline) return -1;
    if (b.impliedDeadline) return 1;
    return 0;
  });
}
