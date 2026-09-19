import "dotenv/config";
import { execTool } from "../swytchcode.js";
import { markNoted } from "../noteLedger.js";
import type { CallLog } from "./email.js";

const DATABASE_ID = process.env.NOTION_DATABASE_ID ?? "";

export interface NoteInput {
  title: string;
  body: string;
  key?: string;
}

const MAX_TEXT = 1900;

const TITLE_CANDIDATES = [process.env.NOTION_TITLE_PROPERTY, "Name", "Title"].filter(
  (v): v is string => Boolean(v),
);

export async function writeNote(note: NoteInput): Promise<{ pageId?: string; calls: CallLog[] }> {
  if (!DATABASE_ID) {
    throw new Error("NOTION_DATABASE_ID is not set — add it to .env and share the database with your integration");
  }

  const body = { rich_text: [{ type: "text", text: { content: note.body.slice(0, MAX_TEXT) } }] };
  const children = [{ object: "block", type: "paragraph", paragraph: body }];
  const titleText = [{ text: { content: note.title.slice(0, MAX_TEXT) } }];

  const attempts: Array<{ label: string; parent: object; properties: object }> = [
    ...TITLE_CANDIDATES.map((property) => ({
      label: `database row (title column "${property}")`,
      parent: { database_id: DATABASE_ID },
      properties: { [property]: { title: titleText } },
    })),
    {
      label: "child page",
      parent: { page_id: DATABASE_ID },
      properties: { title: { title: titleText } },
    },
  ];

  const calls: CallLog[] = [];
  let lastError: string | undefined;

  for (const attempt of attempts) {
    const res = await execTool<{ id?: string; url?: string }>("notes", "notion.page.create", {
      body: { parent: attempt.parent, properties: attempt.properties, children },
    });
    calls.push({ agent: "notes", tool: "notion.page.create", ok: res.ok, ms: res.durationMs });

    if (res.ok) {
      console.log(`[notes] wrote as ${attempt.label}`);
      if (note.key) await markNoted(note.key, res.data?.id);
      return { pageId: res.data?.id, calls };
    }

    lastError = res.error?.message;
    const recoverable = /is not a property that exists|is a page, not a database|is a database, not a page/i;
    if (!recoverable.test(lastError ?? "")) break;
    console.log(`[notes] ${attempt.label} rejected; trying the next shape`);
  }

  throw new Error(
    `Notion write failed: ${lastError}\n` +
      `  · 404 / "could not find" → the page or database is not shared with your integration (open it in Notion → ⋯ → Connections → add your integration)\n` +
      `  · "not a property that exists" → your title column is named something other than ${TITLE_CANDIDATES.join(" or ")}. Set NOTION_TITLE_PROPERTY in .env to its exact name.`,
  );
}

export function suggestNoteForPromise(promise: {
  commitment: string;
  madeToWhom: string;
  impliedDeadline: string | null;
  suggestedAction: string;
}): NoteInput {
  const when = promise.impliedDeadline ? ` — due ${promise.impliedDeadline}` : "";
  return {
    title: `${promise.madeToWhom}: ${promise.commitment}${when}`.slice(0, 180),
    body: `Unscheduled commitment.\n\nPromised: ${promise.commitment}\nTo: ${promise.madeToWhom}\nDeadline: ${promise.impliedDeadline ?? "none stated"}\n\nNext step: ${promise.suggestedAction}`,
  };
}
