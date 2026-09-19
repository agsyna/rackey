import "dotenv/config";
import express from "express";
import {
  WRITE_ACTIONS,
  runAddNote,
  runBrokenPromises,
  runConflicts,
  runDailyBriefing,
  runSendReminder,
  runTriage,
  type Action,
} from "./router.js";
import { AGENT_SCOPES } from "./scopes.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireConfirmation(action: Action, body: unknown): string | null {
  if (!WRITE_ACTIONS.has(action)) return null;
  const confirmed = (body as { confirmed?: unknown })?.confirmed;
  return confirmed === true
    ? null
    : `"${action}" writes to an external service and requires explicit user confirmation (confirmed: true).`;
}

app.get("/api/scopes", (_req, res) => {
  res.json({
    ok: true,
    agents: Object.entries(AGENT_SCOPES).map(([name, s]) => ({
      name,
      capability: s.capability,
      provider: s.provider,
      purpose: s.purpose,
      allow: s.allow,
    })),
  });
});

app.post("/api/triage", async (_req, res) => res.json(await runTriage()));
app.post("/api/conflicts", async (_req, res) => res.json(await runConflicts()));
app.post("/api/promises", async (_req, res) => res.json(await runBrokenPromises()));

app.post("/api/notes", async (req, res) => {
  const denied = requireConfirmation("addNote", req.body);
  if (denied) return res.status(400).json({ ok: false, action: "addNote", error: denied, calls: [] });

  const { title, body, key } = req.body ?? {};
  if (!title || !body) {
    return res.status(400).json({ ok: false, action: "addNote", error: "title and body are required", calls: [] });
  }
  res.json(await runAddNote({ title, body, key }));
});

app.post("/api/reminder", async (req, res) => {
  const denied = requireConfirmation("sendReminder", req.body);
  if (denied) return res.status(400).json({ ok: false, action: "sendReminder", error: denied, calls: [] });

  const { promise } = req.body ?? {};
  if (!promise?.commitment) {
    return res.status(400).json({ ok: false, action: "sendReminder", error: "promise is required", calls: [] });
  }
  res.json(await runSendReminder(promise));
});

app.post("/api/briefing", async (req, res) => {
  const denied = requireConfirmation("dailyBriefing", req.body);
  if (denied) return res.status(400).json({ ok: false, action: "dailyBriefing", error: denied, calls: [] });
  res.json(await runDailyBriefing());
});

app.post("/api/boundary", async (_req, res) => {
  const { execTool } = await import("./swytchcode.js");
  const { ScopeViolationError } = await import("./scopes.js");

  const attempts: Array<{ agent: string; tool: string; why: string }> = [
    { agent: "email", tool: "resend.email.create", why: "the inbox reader must not be able to send mail" },
    { agent: "email", tool: "gmail.user.messages.delete", why: "the inbox reader must not be able to delete mail" },
    { agent: "briefing", tool: "gmail.user.messages.get", why: "the sender must not be able to read the inbox" },
    { agent: "calendar", tool: "calendar.event.update", why: "the calendar agent must not be able to move meetings" },
    { agent: "notes", tool: "notion.page.get", why: "the notes writer is write-only and must not read back" },
  ];

  const results = [];
  for (const attempt of attempts) {
    const started = performance.now();
    try {
      await execTool(attempt.agent as any, attempt.tool, { explain: true });
      results.push({ ...attempt, blocked: false, ms: performance.now() - started });
    } catch (err) {
      results.push({
        ...attempt,
        blocked: err instanceof ScopeViolationError,
        ms: Number((performance.now() - started).toFixed(2)),
        detail: (err as Error).message.split("\n")[0],
      });
    }
  }

  res.json({ ok: results.every((r) => r.blocked), results });
});

interface CredentialState {
  agent: string;
  provider: string;
  ok: boolean;
  detail: string;
  expired: boolean;
}

async function credentialReport(): Promise<CredentialState[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const run = promisify(execFile);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  const results: CredentialState[] = [];

  for (const [agent, scope] of Object.entries(AGENT_SCOPES)) {
    const cwd = path.join(root, "agents", scope.dir);
    let line = "";
    let read = false;

    for (let attempt = 0; attempt < 2 && !read; attempt++) {
      try {
        const { stdout } = await run("swytchcode", ["auth", "status"], { cwd, timeout: 30_000 });
        line = stdout.split("\n").find((l) => l.includes(scope.provider)) ?? "";
        read = true;
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 2500));
      }
    }

    if (!read) {
      results.push({ agent, provider: scope.provider, ok: false, expired: false,
        detail: "could not read status — is your Swytchcode session valid? (swytchcode whoami)" });
    } else if (!line) {
      results.push({ agent, provider: scope.provider, ok: false, expired: false,
        detail: "not connected" });
    } else if (/expired/i.test(line)) {
      results.push({ agent, provider: scope.provider, ok: false, expired: true,
        detail: "token expired" });
    } else {
      results.push({ agent, provider: scope.provider, ok: true, expired: false,
        detail: /api_key/.test(line) ? "api key" : "connected" });
    }
  }

  return results;
}

const PORT = Number(process.env.PORT ?? 8787);
app.listen(PORT, async () => {
  console.log(`Rackey API on http://localhost:${PORT}`);
  console.log("Agents:");
  for (const [name, s] of Object.entries(AGENT_SCOPES)) {
    console.log(`  ${name.padEnd(9)} ${s.capability.padEnd(5)} ${s.provider.padEnd(16)} ${s.allow.join(", ")}`);
  }

  console.log("\nCredentials:");
  const report = await credentialReport();
  for (const r of report) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.agent.padEnd(9)} ${r.provider.padEnd(16)} ${r.detail}`);
  }

  const broken = report.filter((r) => !r.ok);
  if (broken.length === 0) {
    console.log("\nAll four agents can reach their provider. Ready.\n");
    return;
  }

  console.log("");
  const expiredGoogle = broken.filter((r) => r.expired && r.provider.startsWith("g"));
  if (expiredGoogle.length) {
    console.log(
      `⚠  ${expiredGoogle.map((r) => r.agent).join(", ")}: Google OAuth token expired.\n` +
        "   Tokens last ~1 hour and Swytchcode has no refresh command.\n" +
        "   Fix: ./scripts/reconnect-google.sh   then restart this server.",
    );
  }
  for (const r of broken.filter((r) => !expiredGoogle.includes(r))) {
    console.log(
      `⚠  ${r.agent}: ${r.detail}\n` +
        `   Fix: cd agents/${AGENT_SCOPES[r.agent as keyof typeof AGENT_SCOPES].dir} && swytchcode auth connect ${r.provider}`,
    );
  }
  console.log("");
});
