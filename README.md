# Rackey

An executive assistant for Gmail, Google Calendar, Notion and Resend, built on
[Swytchcode](https://swytchcode.com) for Track 4 of the Build with Swytchcode buildathon.

It prioritises your inbox, finds meetings that clash, catches promises you made and never
scheduled, saves notes, and emails you a daily briefing ***like "How a Rack Does"***.

***Checks: it runs as four agents that each hold one capability and one
credential. The agent that reads your inbox has no way to send mail. The agent that sends
has no way to read your inbox. And nothing gets written or sent until you click confirm.***

---

## What it does

| | |
|---|---|
| **Prioritise my inbox** | Ranks by consequence of delay, and quotes the line each ranking is based on so you can check it |
| **Find calendar conflicts** | Finds overlaps and suggests which meeting to move. It can't move anything itself |
| **Follow-ups I owe people** | Pulls promises *you* made out of your mail, then checks each against your calendar. Flags the ones with no time booked |
| **Save to notes** | One click turns a flagged follow-up into a Notion page |
| **Send me today's briefing** | Emails you the three above as one rundown |


---

## How it fits together

```
Chrome side panel
      ↓
router          fixed dispatch table — no LLM decides what runs
      ↓
allowlist       refuses out-of-scope calls in <1ms, before a process is spawned
      ↓
swytchcode exec
      ↓
  email     calendar     notes      briefing     ← four Swytchcode projects
  read      read         write      write        ← four workspaces
  gmail     g-calendar   notion     resend      ← one credential each
```


Every external call goes through `swytchcode exec`. There's no Gmail SDK, no Notion
client, no `fetch` to a provider anywhere in the codebase.

### Who can do what

| Agent | Mode | Canonical IDs |
|---|---|---|
| `email` | read | `gmail.user.messages.get`, `gmail.user.messages.get1` |
| `calendar` | read | `calendar.event.get`, `calendar.event.get.1` |
| `notes` | write | `notion.page.create`, `notion.page.update` |
| `briefing` | write | `resend.email.create` |

The Resend bundle ships 84 methods. The briefing agent is registered for one.

```bash
npm test          # 19 tests, including "exactly one agent can send email"
npm run scopes    # asserts each tooling.json holds exactly its set
npm run boundary  # live: seven out-of-scope attempts, all refused
```

---

## Setup

```bash
npm install
cp .env.example .env              # LLM_API_KEY, NOTION_DATABASE_ID, BRIEFING_TO
./scripts/connect-providers.sh    # OAuth for all four providers
npm run server
```

Then load `extension/` at `chrome://extensions` with Developer mode on.

The server prints a credential check when it starts, so you find out about an expired token
before you click something rather than after.

---

## Things that will trip you up

We hit all of these. They're documented because they look like bugs and aren't.

**Google tokens expire every hour.** Swytchcode has no refresh command — its auth surface is
connect, disconnect, status, workspace. An expired token shows as `connected (expired)` and
every call comes back 401 `had invalid authentication credentials`. Run
`./scripts/reconnect-google.sh`, and run it right before you demo, not twenty minutes before.

**`auth connect` won't replace an expired credential.** The CLI help says connecting again
replaces the account. It doesn't when the token has expired — it reports "already connected"
and does nothing. You have to `auth disconnect` first. The reconnect script does that for you.

**The canonical IDs aren't what you'd guess.** `gmail.user.messages.get` is the *list* call;
`.get1` fetches one message. Same shape for `calendar.event.get` / `.get.1`. Send is
`resend.email.create`, not `resend.emails.send`. The IDs also changed between CLI versions,
so older examples won't run.

**Typed arguments need `exec`'s JSON stdin mode.** `--param maxResults=15` sends the string
`"15"` and the kernel type-checks against the schema, so you get
`field "maxResults" must be an integer, got string`. Pipe `{"tool":…,"args":{…}}` instead.

**The published Notion bundle is broken.** It references 20 response structs and defines 3,
so `swytchcode add method notion.page.create` fails on an unresolvable struct.
`scripts/patch-notion-wrekenfile.py` repairs it and is safe to re-run.

**`bundle missing` after moving projects around** → `swytchcode bootstrap` in that agent's
directory.

**Notion integrations are granted per page.** Sharing the workspace isn't enough — open the
page or database, `⋯` → Connections, add your integration, or writes 404.

---


## Layout

```
agents/{email,calendar,notes,briefing}/   four scoped Swytchcode projects
src/scopes.ts                             the allowlist — the real permission boundary
src/swytchcode.ts                         the only path to the outside world
src/agents/                               one module per agent
src/detectors/brokenPromises.ts           pure function, no API calls
src/router.ts                             dispatch table
src/server.ts                             local API for the side panel
extension/                                Chrome MV3 side panel
```

| Command | |
|---|---|
| `npm run server` | Local API; one audit line per external call |
| `npm test` | Offline tests for scopes and the detector |
| `npm run boundary` | Permission demo |
| `npm run scopes` | Check on-disk scopes match intent |
| `./scripts/reconnect-google.sh` | Refresh expired Google tokens |
| `python3 scripts/reset-scopes.py` | Repair scope drift |
