const API = "http://localhost:8787";

const el = (id) => document.getElementById(id);
const out = el("out");
const status = el("status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = `status ${kind}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const buttons = () => [...document.querySelectorAll(".actions button")];

async function call(path, body, progress) {
  buttons().forEach((b) => (b.disabled = true));
  setStatus(progress);
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json();
    if (!json.ok) {
      setStatus(json.error || "Request failed", "err");
      return json;
    }
    const calls = json.calls?.length ?? 0;
    setStatus(calls ? `Done — ${calls} call(s), all through Swytchcode.` : "Done.", "ok");
    return json;
  } catch (err) {
    setStatus(`Cannot reach the Rackey API — is \`npm run server\` running? (${err.message})`, "err");
    return { ok: false };
  } finally {
    buttons().forEach((b) => (b.disabled = false));
  }
}

function confirmWrite(message) {
  return window.confirm(`${message}\n\nThis sends data to an external service.`);
}

function auditTable(calls) {
  if (!calls?.length) return "";
  const rows = calls
    .map((c) => `<tr><td>${esc(c.agent)}</td><td><code>${esc(c.tool)}</code></td><td>${c.ok ? "ok" : "failed"}</td><td>${c.ms}ms</td></tr>`)
    .join("");
  return `<h2>Calls made</h2><div class="scroll"><table><tr><th>Agent</th><th>Canonical ID</th><th></th><th></th></tr>${rows}</table></div>`;
}

function renderTriage(d, calls) {
  const items = d.triaged?.length
    ? d.triaged.map((e) => `
        <div class="card">
          <div class="row">
            <span class="subject">${esc(e.subject)}</span>
            <span class="tag ${e.urgency}">${esc(e.urgency)}</span>
          </div>
          <div class="meta">${esc(e.from)}</div>
          <p class="reason">${esc(e.reason)}</p>
          <blockquote>${esc(e.sourceSnippet)}</blockquote>
        </div>`).join("")
    : `<div class="empty">No emails ranked.</div>`;

  out.innerHTML = `<h2>Inbox priorities — ${d.emailCount ?? 0} email(s) read</h2>${items}
    <h2>Promises you made</h2>${
      d.commitments?.length
        ? d.commitments.map((c) => `<div class="card"><strong>${esc(c.text)}</strong>
            <div class="meta">to ${esc(c.madeToWhom)}${c.impliedDeadline ? ` · due ${esc(c.impliedDeadline)}` : ""}</div></div>`).join("")
        : `<div class="empty">None detected.</div>`
    }${auditTable(calls)}`;
}

function renderConflicts(d, calls) {
  out.innerHTML = `<h2>Calendar conflicts — ${d.eventCount ?? 0} event(s) read</h2>${
    d.conflicts?.length
      ? d.conflicts.map((c) => `
          <div class="card">
            <div class="subject">${esc(c.a.summary)} ↔ ${esc(c.b.summary)}</div>
            <div class="meta">overlaps by ${c.overlapMinutes} min</div>
            ${c.proposedResolution ? `<p class="reason">${esc(c.proposedResolution)}</p>` : ""}
            <div class="meta">Suggestion only — Rackey cannot move your meetings.</div>
          </div>`).join("")
      : `<div class="empty">No overlapping meetings found.</div>`
  }${auditTable(calls)}`;
}

function renderPromises(d, calls) {
  const notes = new Map((d.suggestedNotes ?? []).map((n) => [n.key, n]));

  out.innerHTML = `<h2>Follow-ups you owe — ${d.commitmentsFound ?? 0} promise(s) checked</h2>${
    d.brokenPromises?.length
      ? d.brokenPromises.map((p, i) => `
          <div class="card">
            <div class="subject">${esc(p.commitment)}</div>
            <div class="meta">to ${esc(p.madeToWhom)}${p.impliedDeadline ? ` · due ${esc(p.impliedDeadline)}` : " · no date stated"}</div>
            <p class="reason">${esc(p.evidence)}</p>
            <blockquote>${esc(p.sourceSnippet)}</blockquote>
            <p class="reason"><strong>Next:</strong> ${esc(p.suggestedAction)}</p>
            <div class="btnrow">
              <button class="tiny" data-note="${i}">Save to notes</button>
              <button class="tiny" data-remind="${i}">Email me a reminder</button>
            </div>
          </div>`).join("")
      : d.commitmentsFound
        ? `<div class="empty">Nothing outstanding — all ${d.commitmentsFound} promise(s) found in your mail already have time booked.</div>`
        : `<div class="empty">No promises found in the ${d.emailsRead ?? "recent"} emails read, so there was nothing to check against your calendar.<br><br>This looks for commitments <em>you</em> made \u2014 "I'll send you the deck by Friday". Notification mail has none.</div>`
  }${auditTable(calls)}`;

  out.querySelectorAll("[data-note]").forEach((btn) => {
    btn.onclick = async () => {
      const promise = d.brokenPromises[Number(btn.dataset.note)];
      const note = notes.get(promise.key);
      if (!note) return setStatus("No suggested note for this item.", "err");
      if (!confirmWrite(`Add this note to Notion?\n\n"${note.title}"`)) return;

      const res = await call("/api/notes", { ...note, confirmed: true }, "Writing to Notion…");
      if (res.ok) { btn.disabled = true; btn.textContent = "Saved to notes"; }
    };
  });

  out.querySelectorAll("[data-remind]").forEach((btn) => {
    btn.onclick = async () => {
      const promise = d.brokenPromises[Number(btn.dataset.remind)];
      if (!confirmWrite(`Email yourself a reminder about:\n\n"${promise.commitment}"`)) return;

      const res = await call("/api/reminder", { promise, confirmed: true }, "Sending reminder…");
      if (res.ok) {
        btn.disabled = true;
        btn.textContent = res.data?.deduped ? "Already sent" : "Reminder sent";
      }
    };
  });
}

function renderBriefing(d, calls) {
  const b = d.briefing ?? {};
  out.innerHTML = `<h2>Daily briefing ${d.deduped ? "(already sent today)" : "sent"}</h2>
    <div class="card"><p class="reason">${esc(b.summary)}</p></div>
    <div class="note">
      <div>${b.topEmails?.length ?? 0} priority email(s) · ${b.conflicts?.length ?? 0} conflict(s) · ${b.brokenPromises?.length ?? 0} unscheduled commitment(s)</div>
    </div>${auditTable(calls)}`;
}

function renderBoundary(json) {
  out.innerHTML = `<h2>Permission check</h2>
    <div class="note">Each agent was asked to do something outside its job. Every attempt is refused before it can reach Gmail, Calendar, Notion or Resend.</div>
    ${json.results.map((r) => `
      <div class="card">
        <div class="row">
          <span class="subject">${esc(r.agent)} → <code>${esc(r.tool)}</code></span>
          <span class="verdict ${r.blocked ? "pass" : "fail"}">${r.blocked ? `blocked ${r.ms}ms` : "leaked"}</span>
        </div>
        <div class="meta">${esc(r.why)}</div>
      </div>`).join("")}
    <div class="note">${json.ok ? "Every out-of-bounds attempt was refused." : "A capability leaked — see above."}</div>`;
}

el("btn-triage").onclick = async () => {
  const r = await call("/api/triage", {}, "Reading your inbox…");
  if (r.ok) renderTriage(r.data, r.calls);
};

el("btn-conflicts").onclick = async () => {
  const r = await call("/api/conflicts", {}, "Reading your calendar…");
  if (r.ok) renderConflicts(r.data, r.calls);
};

el("btn-promises").onclick = async () => {
  const r = await call("/api/promises", {}, "Checking your promises against your calendar…");
  if (r.ok) renderPromises(r.data, r.calls);
};

el("btn-briefing").onclick = async () => {
  if (!confirmWrite("Compile today's briefing and email it to you?")) return;
  const r = await call("/api/briefing", { confirmed: true }, "Compiling briefing and sending…");
  if (r.ok) renderBriefing(r.data, r.calls);
};

el("btn-boundary").onclick = async () => {
  const r = await call("/api/boundary", {}, "Attempting five out-of-bounds actions…");
  if (r.results) renderBoundary(r);
};

setStatus("Ready. Start the API with `npm run server`.");
