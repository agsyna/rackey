import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_SCOPES, ScopeViolationError, assertInScope, isInScope } from "./scopes.js";
import { execTool } from "./swytchcode.js";

test("each agent is read-only or write-only, never both", () => {
  for (const [name, scope] of Object.entries(AGENT_SCOPES)) {
    assert.ok(["read", "write"].includes(scope.capability), `${name} has an odd capability`);
  }
});

test("exactly one agent in the entire system can send email", () => {
  const senders = Object.entries(AGENT_SCOPES).filter(([, s]) =>
    s.allow.includes("resend.email.create"),
  );
  assert.equal(senders.length, 1);
  assert.equal(senders[0][0], "briefing");
});

test("no two agents share a provider credential", () => {
  const providers = Object.values(AGENT_SCOPES).map((s) => s.provider);
  assert.equal(new Set(providers).size, providers.length);
});

test("read agents hold no write capability", () => {
  const writeVerbs = [".create", ".update", ".delete"];
  for (const [name, scope] of Object.entries(AGENT_SCOPES)) {
    if (scope.capability !== "read") continue;
    for (const tool of scope.allow) {
      assert.ok(
        !writeVerbs.some((v) => tool.endsWith(v)),
        `read-only agent "${name}" holds write-shaped tool ${tool}`,
      );
    }
  }
});

test("the inbox reader cannot send mail", () => {
  assert.throws(() => assertInScope("email", "resend.email.create"), ScopeViolationError);
  assert.equal(isInScope("email", "resend.email.create"), false);
});

test("the sender cannot read the inbox", () => {
  assert.throws(() => assertInScope("briefing", "gmail.user.messages.get"), ScopeViolationError);
});

test("the calendar agent cannot move meetings", () => {
  assert.throws(() => assertInScope("calendar", "calendar.event.update"), ScopeViolationError);
  assert.throws(() => assertInScope("calendar", "calendar.event.delete"), ScopeViolationError);
});

test("the notes writer is write-only and cannot read back", () => {
  assert.throws(() => assertInScope("notes", "notion.page.get"), ScopeViolationError);
});

test("in-scope tools are permitted", () => {
  assert.doesNotThrow(() => assertInScope("email", "gmail.user.messages.get"));
  assert.doesNotThrow(() => assertInScope("briefing", "resend.email.create"));
});

test("execTool refuses out-of-scope calls without spawning a process", async () => {
  const started = Date.now();
  await assert.rejects(
    () => execTool("email", "resend.email.create", { body: { to: "x@example.com" } }),
    ScopeViolationError,
  );
  assert.ok(Date.now() - started < 250, "rejection should be immediate and offline");
});
