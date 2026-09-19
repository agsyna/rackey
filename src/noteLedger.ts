import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = path.join(REPO_ROOT, ".rackey", "noted.json");

interface LedgerShape {
  noted: Record<string, { at: string; pageId?: string }>;
  sent: Record<string, { at: string; id?: string }>;
}

async function load(): Promise<LedgerShape> {
  try {
    return JSON.parse(await readFile(LEDGER, "utf8")) as LedgerShape;
  } catch {
    return { noted: {}, sent: {} };
  }
}

async function save(data: LedgerShape): Promise<void> {
  await mkdir(path.dirname(LEDGER), { recursive: true });
  await writeFile(LEDGER, `${JSON.stringify(data, null, 2)}\n`);
}

export async function notedKeys(): Promise<Set<string>> {
  return new Set(Object.keys((await load()).noted));
}

export async function markNoted(key: string, pageId?: string): Promise<void> {
  const data = await load();
  data.noted[key] = { at: new Date().toISOString(), pageId };
  await save(data);
}

export async function alreadySent(key: string): Promise<boolean> {
  return Boolean((await load()).sent[key]);
}

export async function markSent(key: string, id?: string): Promise<void> {
  const data = await load();
  data.sent[key] = { at: new Date().toISOString(), id };
  await save(data);
}
