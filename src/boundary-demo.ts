import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENT_SCOPES, ScopeViolationError, type AgentName } from "./scopes.js";
import { execTool } from "./swytchcode.js";

const run = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface Attempt {
  agent: AgentName;
  tool: string;
  why: string;
}

const FORBIDDEN: Attempt[] = [
  { agent: "email", tool: "resend.email.create", why: "inbox reader must not be able to send mail" },
  { agent: "email", tool: "gmail.user.messages.delete", why: "inbox reader must not be able to delete mail" },
  { agent: "briefing", tool: "gmail.user.messages.get", why: "the sender must not be able to read the inbox" },
  { agent: "calendar", tool: "calendar.event.update", why: "calendar agent must not be able to move meetings" },
  { agent: "calendar", tool: "calendar.event.delete", why: "calendar agent must not be able to cancel meetings" },
  { agent: "notes", tool: "notion.page.get", why: "notes writer is write-only and must not read back" },
  { agent: "notes", tool: "resend.email.create", why: "notes writer must not be able to send mail" },
];

async function act1(): Promise<boolean> {
  console.log(bold("\nAct 1 — every agent asked to overstep\n"));
  let allBlocked = true;

  for (const { agent, tool, why } of FORBIDDEN) {
    const started = performance.now();
    try {
      await execTool(agent, tool, { explain: true });
      console.log(`  ${red("✗ ALLOWED")}  ${agent} → ${tool}`);
      console.log(`             ${red("capability leak:")} ${why}`);
      allBlocked = false;
    } catch (err) {
      const ms = (performance.now() - started).toFixed(2);
      if (err instanceof ScopeViolationError) {
        console.log(`  ${green("✓ BLOCKED")}  ${agent} → ${tool}  ${dim(`(${ms}ms)`)}`);
        console.log(`             ${dim(why)}`);
      } else {
        console.log(`  ${red("✗ UNEXPECTED")} ${agent} → ${tool}: ${(err as Error).message}`);
        allBlocked = false;
      }
    }
  }
  return allBlocked;
}

async function act2(): Promise<boolean> {
  console.log(bold("\nAct 2 — legitimate work still flows\n"));

  const cases: Array<{ agent: AgentName; tool: string; inputs: Record<string, string> }> = [
    { agent: "email", tool: "gmail.user.messages.get", inputs: { userId: "me" } },
    { agent: "calendar", tool: "calendar.event.get", inputs: { calendarId: "primary" } },
  ];

  let allOk = true;
  for (const { agent, tool, inputs } of cases) {
    const res = await execTool(agent, tool, { inputs, explain: true });
    if (res.ok) {
      console.log(`  ${green("✓ RESOLVED")} ${agent} → ${tool}  ${dim(`(${res.durationMs}ms, no HTTP call)`)}`);
    } else {
      console.log(`  ${red("✗ FAILED")}   ${agent} → ${tool}: ${res.error?.message}`);
      allOk = false;
    }
  }
  return allOk;
}

async function act3(): Promise<void> {
  console.log(bold("\nAct 3 — why Act 1 has to exist\n"));

  const agent: AgentName = "email";
  const forbidden = "resend.email.create";
  const dir = path.join(REPO_ROOT, "agents", AGENT_SCOPES[agent].dir);
  const tj = path.join(dir, ".swytchcode", "tooling.json");
  const snapshot = await readFile(tj, "utf8");

  console.log(
    `  The ${bold(agent)} agent is registered for ${AGENT_SCOPES[agent].allow.length} read methods only.`,
  );
  console.log(`  Calling the ${bold("bare CLI")} (no Rackey allowlist): ${dim(`swytchcode exec ${forbidden}`)}\n`);

  try {
    await run("swytchcode", ["exec", forbidden, "--explain", "--json"], { cwd: dir, timeout: 120_000 });
  } catch {
  }

  const after = Object.keys(JSON.parse(await readFile(tj, "utf8")).tools ?? {});
  if (after.includes(forbidden)) {
    console.log(`  ${yellow("⚠ tooling.json now contains:")} ${forbidden}`);
    console.log(`  ${yellow("  The read-only agent granted itself send permission, just by asking.")}`);
    console.log(`  ${dim("  This is why the permission boundary lives in our code, not in this file.")}`);
  } else {
    console.log(`  ${dim("The CLI refused this time — but the refusal is not dependable:")}`);
    console.log(`  ${dim("it depends on the registry fetch failing (it is heavily rate-limited).")}`);
    console.log(`  ${dim("A boundary that holds only when the network misbehaves is not a boundary.")}`);
  }

  await writeFile(tj, snapshot);
  console.log(`\n  ${dim("tooling.json restored.")}`);
}

const showGap = process.argv.includes("--show-gap");

console.log(bold("═══ Rackey — try to break it ═══"));
console.log(dim("Four agents. Each holds exactly one capability set. Nothing else."));
for (const [name, s] of Object.entries(AGENT_SCOPES)) {
  console.log(dim(`  ${name.padEnd(9)} ${s.capability.padEnd(5)} ${s.provider.padEnd(16)} ${s.allow.join(", ")}`));
}

const blocked = await act1();
const flowed = await act2();
if (showGap) await act3();
else console.log(dim("\n(run with --show-gap to see the platform behaviour this defends against)"));

console.log(
  bold(
    blocked && flowed
      ? green("\n✓ All out-of-scope calls blocked; all in-scope calls resolved.\n")
      : red("\n✗ Boundary test failed — see above.\n"),
  ),
);
process.exit(blocked && flowed ? 0 : 1);
