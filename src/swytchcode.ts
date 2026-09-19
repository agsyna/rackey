
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SCOPES, assertInScope, type AgentName } from "./scopes.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RATE_LIMIT_PATTERNS = [/status 429/, /Rate limit exceeded/, /Failed to fetch/];
const MAX_ATTEMPTS = 5;

export interface ExecOptions {
  inputs?: Record<string, string | number | boolean>;
  params?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  explain?: boolean;
  timeoutMs?: number;
}

export interface ExecResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { message: string; category?: string; suggestedAction?: string };
  tool: string;
  agent: AgentName;
  durationMs: number;
}

export class ScopeDriftError extends Error {
  constructor(agent: AgentName, added: string[]) {
    super(
      `Scope drift detected: the Swytchcode CLI self-registered ${added.join(", ")} ` +
        `into the "${agent}" agent's tooling.json. Rackey reverted it. ` +
        `This is the platform behaviour our allowlist exists to contain.`,
    );
    this.name = "ScopeDriftError";
  }
}

function agentDir(agent: AgentName): string {
  return path.join(REPO_ROOT, "agents", AGENT_SCOPES[agent].dir);
}

function toolingPath(agent: AgentName): string {
  return path.join(agentDir(agent), ".swytchcode", "tooling.json");
}

async function readRegisteredTools(agent: AgentName): Promise<string[]> {
  try {
    const raw = await readFile(toolingPath(agent), "utf8");
    return Object.keys(JSON.parse(raw).tools ?? {});
  } catch {
    return [];
  }
}

async function revertDrift(agent: AgentName, unexpected: string[]): Promise<void> {
  const file = toolingPath(agent);
  const doc = JSON.parse(await readFile(file, "utf8"));
  for (const tool of unexpected) delete doc.tools[tool];

  const stillNeeded = new Set(
    Object.values(doc.tools as Record<string, { integration?: string }>)
      .map((t) => t.integration?.split("@")[0])
      .filter(Boolean) as string[],
  );
  for (const key of Object.keys(doc.integrations ?? {})) {
    if (!stillNeeded.has(key)) delete doc.integrations[key];
  }

  await writeFile(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function buildInvocation(
  tool: string,
  opts: ExecOptions,
): { argv: string[]; stdin: string } {
  const argv = ["exec", "--json"];
  for (const [k, v] of Object.entries(opts.headers ?? {})) argv.push("--header", `${k}=${v}`);
  if (opts.explain) argv.push("--explain");

  const args: Record<string, unknown> = { ...(opts.inputs ?? {}), ...(opts.params ?? {}) };
  if (opts.body !== undefined) args.body = opts.body;

  return { argv, stdin: JSON.stringify({ tool, args }) };
}

function extractJson(stdout: string): unknown | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return undefined;
}

function runCli(
  agent: AgentName,
  argv: string[],
  stdin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      "swytchcode",
      argv,
      { cwd: agentDir(agent), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", failed: Boolean(err) });
      },
    );
    child.stdin?.end(stdin);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function execTool<T = unknown>(
  agent: AgentName,
  tool: string,
  opts: ExecOptions = {},
): Promise<ExecResult<T>> {
  assertInScope(agent, tool);

  const started = Date.now();
  const before = await readRegisteredTools(agent);
  const { argv, stdin } = buildInvocation(tool, opts);
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let last = { stdout: "", stderr: "", failed: true };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await runCli(agent, argv, stdin, timeoutMs);
    const combined = `${last.stdout}\n${last.stderr}`;

    if (RATE_LIMIT_PATTERNS.some((p) => p.test(combined)) && attempt < MAX_ATTEMPTS) {
      const hinted = /retry in (\d+)/.exec(combined)?.[1];
      await sleep((hinted ? Number(hinted) : 4) * 1000 + attempt * 1500);
      continue;
    }
    break;
  }

  const after = await readRegisteredTools(agent);
  const added = after.filter((t) => !before.includes(t));
  const unexpected = added.filter((t) => !AGENT_SCOPES[agent].allow.includes(t));
  if (unexpected.length > 0) {
    await revertDrift(agent, unexpected);
    throw new ScopeDriftError(agent, unexpected);
  }

  const payload = extractJson(last.stdout) as Record<string, unknown> | undefined;
  const durationMs = Date.now() - started;

  const log = (verdict: string, detail = "") =>
    console.log(
      `[${new Date().toISOString().slice(11, 19)}] ${agent.padEnd(8)} ${tool.padEnd(30)} ${verdict.padEnd(9)} ${String(durationMs).padStart(5)}ms ${detail}`,
    );

  if (payload && typeof payload.error === "string") {
    log("KERNEL-ERR", String(payload.error).slice(0, 120));
    return {
      ok: false,
      tool,
      agent,
      durationMs,
      error: {
        message: payload.error,
        category: payload.category as string | undefined,
        suggestedAction: payload.suggested_action as string | undefined,
      },
    };
  }

  if (payload && "status_code" in payload) {
    const status = Number(payload.status_code);
    const inner = payload.data as Record<string, unknown> | undefined;

    if (status >= 400) {
      const nested = inner?.error as Record<string, unknown> | undefined;
      const source = (nested && typeof nested === "object" ? nested : inner) ?? {};
      const label =
        (source as { status?: string | number; code?: string }).status ??
        (source as { code?: string }).code;
      const providerError = {
        message: (source as { message?: string }).message,
        status: String(label ?? "") === String(status) ? undefined : (label as string | undefined),
      };

      const provider = AGENT_SCOPES[agent].provider;
      const reconnect = `cd agents/${AGENT_SCOPES[agent].dir} && swytchcode auth connect ${provider}`;
      const expired = /invalid authentication credentials|had invalid/i.test(
        providerError.message ?? "",
      );
      const hint =
        status === 401
          ? expired
            ? ` — the ${provider} token has EXPIRED (OAuth tokens last ~1 hour). Reconnect: ${reconnect}`
            : ` — no ${provider} credential in this agent's workspace. Connect: ${reconnect}`
          : "";
      log(`HTTP ${status}`, `${providerError.status ?? ""} ${(providerError.message ?? "").slice(0, 110)}`);
      return {
        ok: false,
        tool,
        agent,
        durationMs,
        error: {
          message: `${status} ${providerError.status ?? ""} ${providerError.message ?? "provider call failed"}`.trim() + hint,
          category: status === 401 ? "auth" : "provider_error",
        },
      };
    }
    log(`HTTP ${status}`);
    return { ok: true, tool, agent, durationMs, data: inner as T };
  }

  if (last.failed && !payload) {
    const detail = (last.stderr || last.stdout).trim().split("\n").slice(-3).join(" ").trim();
    log("CLI-FAIL", detail.slice(0, 120));
    return {
      ok: false,
      tool,
      agent,
      durationMs,
      error: { message: detail || "swytchcode exec failed with no output", category: "cli_error" },
    };
  }

  log("OK");
  return { ok: true, tool, agent, durationMs, data: payload as T };
}
