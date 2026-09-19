
export interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body: string;
  snippet: string;
}

export interface TriagedEmail {
  id: string;
  subject: string;
  from: string;
  urgency: "high" | "medium" | "low";
  reason: string;
  sourceSnippet: string;
}

export interface Commitment {
  text: string;
  madeToWhom: string;
  impliedDeadline: string | null;
  sourceEmailId: string;
  sourceSnippet: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  hasExternalAttendees: boolean;
}

export interface Conflict {
  a: CalendarEvent;
  b: CalendarEvent;
  overlapMinutes: number;
  proposedResolution?: string;
}

export interface BrokenPromise {
  commitment: string;
  madeToWhom: string;
  impliedDeadline: string | null;
  status: "unscheduled";
  evidence: string;
  suggestedAction: string;
  sourceEmailId: string;
  sourceSnippet: string;
  key: string;
}

export interface DailyBriefing {
  generatedAt: string;
  topEmails: TriagedEmail[];
  conflicts: Conflict[];
  brokenPromises: BrokenPromise[];
  summary: string;
}

export interface ActionResult<T> {
  ok: boolean;
  action: string;
  data?: T;
  error?: string;
  calls: Array<{ agent: string; tool: string; ok: boolean; ms: number }>;
}
