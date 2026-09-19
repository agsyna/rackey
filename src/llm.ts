import "dotenv/config";

const BASE_URL = process.env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1";
const MODEL = process.env.LLM_MODEL ?? "llama-3.3-70b-versatile";
const API_KEY = process.env.LLM_API_KEY ?? "";

export class LLMError extends Error {}

export async function completeJSON<T>(system: string, user: string, maxTokens = 1800): Promise<T> {
  if (!API_KEY) throw new LLMError("LLM_API_KEY is not set — copy .env.example to .env");

  const attempt = async (strict: boolean) => {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        temperature: 0,
        ...(strict ? { response_format: { type: "json_object" } } : {}),
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  };

  const runWithBackoff = async (strict: boolean) => {
    for (let tries = 0; tries < 3; tries++) {
      const res = await attempt(strict);
      if (res.ok || res.status !== 429) return res;

      const waitSeconds = Number(/try again in ([\d.]+)/.exec(res.text)?.[1] ?? 8);
      console.log(`[llm] rate limited, waiting ${waitSeconds.toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, Math.min(waitSeconds + 1, 30) * 1000));
    }
    return attempt(strict);
  };

  let result = await runWithBackoff(true);

  if (!result.ok && result.text.includes("json_validate_failed")) {
    console.log("[llm] strict JSON mode rejected its own output; retrying without it");
    result = await runWithBackoff(false);
  }

  if (!result.ok) throw new LLMError(`LLM ${result.status}: ${result.text.slice(0, 300)}`);

  const payload = JSON.parse(result.text) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return parseLoose<T>(payload.choices?.[0]?.message?.content ?? "");
}

export async function completeText(system: string, user: string, maxTokens = 1024): Promise<string> {
  if (!API_KEY) throw new LLMError("LLM_API_KEY is not set — copy .env.example to .env");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) throw new LLMError(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (payload.choices?.[0]?.message?.content ?? "").trim();
}

function parseLoose<T>(text: string): T {
  const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
  }

  const start = cleaned.indexOf("{");
  if (start === -1) throw new LLMError(`LLM returned no JSON object: ${text.slice(0, 200)}`);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return JSON.parse(cleaned.slice(start, i + 1)) as T;
    }
  }
  throw new LLMError(`LLM returned malformed JSON: ${text.slice(0, 200)}`);
}
