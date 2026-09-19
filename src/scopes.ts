
export type AgentName = "email" | "calendar" | "notes" | "briefing";

export type Capability = "read" | "write";

export interface AgentScope {
  dir: AgentName;
  purpose: string;
  capability: Capability;
  provider: string;
  allow: readonly string[];
}

export const AGENT_SCOPES: Record<AgentName, AgentScope> = {
  email: {
    dir: "email",
    purpose: "read the inbox for triage and commitment extraction",
    capability: "read",
    provider: "gmail",
    allow: ["gmail.user.messages.get", "gmail.user.messages.get1"],
  },
  calendar: {
    dir: "calendar",
    purpose: "read calendar events to detect conflicts and match commitments",
    capability: "read",
    provider: "google-calendar",
    allow: ["calendar.event.get", "calendar.event.get.1"],
  },
  notes: {
    dir: "notes",
    purpose: "append confirmed items to the executive notes database",
    capability: "write",
    provider: "notion",
    allow: ["notion.page.create", "notion.page.update"],
  },
  briefing: {
    dir: "briefing",
    purpose: "send reminders and the daily briefing",
    capability: "write",
    provider: "resend",
    allow: ["resend.email.create"],
  },
};

export class ScopeViolationError extends Error {
  readonly agent: AgentName;
  readonly tool: string;
  readonly allowed: readonly string[];

  constructor(agent: AgentName, tool: string) {
    const scope = AGENT_SCOPES[agent];
    super(
      `Scope violation: the "${agent}" agent may not call "${tool}".\n` +
        `  This agent is ${scope.capability}-only, scoped to ${scope.purpose}.\n` +
        `  It may call: ${scope.allow.join(", ")}\n` +
        `  Blocked by Rackey's allowlist before reaching the Swytchcode CLI.`,
    );
    this.name = "ScopeViolationError";
    this.agent = agent;
    this.tool = tool;
    this.allowed = scope.allow;
  }
}

export function assertInScope(agent: AgentName, tool: string): void {
  const scope = AGENT_SCOPES[agent];
  if (!scope) throw new ScopeViolationError(agent, tool);
  if (!scope.allow.includes(tool)) throw new ScopeViolationError(agent, tool);
}

export function isInScope(agent: AgentName, tool: string): boolean {
  return AGENT_SCOPES[agent]?.allow.includes(tool) ?? false;
}
