import assert from "node:assert/strict";
import { test } from "node:test";
import { commitmentKey, detectBrokenPromises } from "./brokenPromises.js";
import type { CalendarEvent, Commitment } from "../types.js";

const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  text: "I'll send you the Q3 revenue deck by Friday",
  madeToWhom: "Sarah",
  impliedDeadline: "2026-08-14",
  sourceEmailId: "m1",
  sourceSnippet: "I'll send you the Q3 revenue deck by Friday",
  ...over,
});

const event = (summary: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `e-${summary}`,
  summary,
  start: "2026-08-12T10:00:00Z",
  end: "2026-08-12T11:00:00Z",
  attendees: [],
  hasExternalAttendees: false,
  ...over,
});

test("flags a commitment with nothing on the calendar", () => {
  const found = detectBrokenPromises([commitment()], [event("Dentist"), event("Standup")]);
  assert.equal(found.length, 1);
  assert.equal(found[0].status, "unscheduled");
  assert.equal(found[0].madeToWhom, "Sarah");
});

test("clears a commitment when a matching event exists", () => {
  const found = detectBrokenPromises(
    [commitment()],
    [event("Prepare Q3 revenue deck for Sarah")],
  );
  assert.equal(found.length, 0);
});

test("an unrelated event with a shared stopword does not clear a commitment", () => {
  const found = detectBrokenPromises([commitment()], [event("Walk the dog by the park")]);
  assert.equal(found.length, 1);
});

test("every flagged promise carries evidence and a real source quote", () => {
  const found = detectBrokenPromises([commitment()], [event("Standup")]);
  assert.ok(found[0].evidence.length > 0, "must explain why it was flagged");
  assert.equal(found[0].sourceSnippet, commitment().sourceSnippet);
});

test("an empty calendar is reported as such rather than silently matching", () => {
  const found = detectBrokenPromises([commitment()], []);
  assert.match(found[0].evidence, /No calendar events/);
});

test("already-noted promises are suppressed", () => {
  const c = commitment();
  const found = detectBrokenPromises([c], [], { alreadyNoted: new Set([commitmentKey(c)]) });
  assert.equal(found.length, 0);
});

test("commitment keys are stable and content-addressed", () => {
  assert.equal(commitmentKey(commitment()), commitmentKey(commitment()));
  assert.notEqual(commitmentKey(commitment()), commitmentKey(commitment({ text: "different" })));
});

test("dated promises sort ahead of undated ones, soonest first", () => {
  const found = detectBrokenPromises(
    [
      commitment({ text: "later thing", impliedDeadline: "2026-09-01", sourceEmailId: "a" }),
      commitment({ text: "undated thing", impliedDeadline: null, sourceEmailId: "b" }),
      commitment({ text: "urgent thing", impliedDeadline: "2026-08-11", sourceEmailId: "c" }),
    ],
    [],
  );
  assert.deepEqual(found.map((p) => p.commitment), ["urgent thing", "later thing", "undated thing"]);
});

test("the seeded demo case: promise to Sarah, double-booked calendar, nothing scheduled", () => {
  const commitments = [
    commitment({ text: "I'll send you the deck by Friday", madeToWhom: "Sarah" }),
    commitment({ text: "I will review the vendor contract", madeToWhom: "Legal", sourceEmailId: "m2", impliedDeadline: null }),
  ];
  const events = [
    event("Board sync", { start: "2026-08-12T14:00:00Z", end: "2026-08-12T15:00:00Z" }),
    event("Vendor contract review with Legal", { start: "2026-08-12T14:30:00Z", end: "2026-08-12T15:30:00Z" }),
  ];

  const found = detectBrokenPromises(commitments, events);
  assert.equal(found.length, 1);
  assert.match(found[0].commitment, /deck/);
});
