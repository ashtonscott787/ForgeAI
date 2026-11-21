import { useCallback, useEffect, useState } from "react";
import { api, type ContactRow } from "../lib/ipc";

/**
 * Who people are, built from your own mail.
 *
 * Everything Forge AI worked out is a question until you answer it. Nothing
 * reaches a model, or an email it writes for you, until you have said yes —
 * because a guess repeated back later with someone's name on it is worse than
 * having no record of them at all.
 */
const LABEL: Record<string, string> = {
  name: "Name",
  organisation: "Organisation",
  role: "Role",
  phone: "Phone",
  location: "Location",
  note: "Note",
};

export function People({ onAsk }: { onAsk: (text: string) => void }) {
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [onlyAsking, setOnlyAsking] = useState(false);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    void api.contactsList(onlyAsking).then(setRows).catch(() => undefined);
  }, [onlyAsking]);
  useEffect(load, [load]);

  const decide = (email: string, factId: string, state: "confirmed" | "rejected") =>
    void api.contactsDecide({ email, fact_id: factId, state }).then(load).catch(() => undefined);

  const asking = rows.reduce((n, r) => n + r.pending.length, 0);

  return (
    <>
      <div className="phead">
        <h2>People</h2>
        <p>Built from your mail. Nothing is treated as true until you say so.</p>
      </div>
      <div className="scroll">
        <div className="pbody">
          <div className="sharerow">
            <button
              className="ghostbtn"
              disabled={Boolean(busy)}
              onClick={() => {
                setBusy("scan");
                setNote("");
                void api.contactsScan(40)
                  .then((r) => setNote(r.ok ? `Read ${r.read} emails and found ${r.people} ${r.people === 1 ? "person" : "people"}.` : r.error ?? "The inbox could not be read."))
                  .catch((e) => setNote(String(e)))
                  .finally(() => { setBusy(""); load(); });
              }}
            >
              {busy === "scan" ? "Reading your mail…" : "Learn from my inbox"}
            </button>
            <label className="hint livetoggle">
              <input type="checkbox" checked={onlyAsking} onChange={(e) => setOnlyAsking(e.target.checked)} aria-label="Only those with questions" />
              Only those with questions
            </label>
            {asking > 0 && <span className="hint">{asking} thing{asking === 1 ? "" : "s"} to confirm</span>}
          </div>

          {note && <div className="hint">{note}</div>}

          {rows.length === 0 && (
            <p className="hint">
              Nobody yet. “Learn from my inbox” reads who has written to you and proposes
              what it can work out. You decide what is true.
            </p>
          )}

          <ul className="peoplelist">
            {rows.map((r) => (
              <li key={r.email} className="personrow">
                <div className="personhead">
                  <span className="personname">{r.known?.name || r.email}</span>
                  {r.known?.name && <span className="hint num">{r.email}</span>}
                  <span className="hint">seen {r.seen}×</span>
                  <span className="personacts">
                    <button className="ghostbtn" onClick={() => onAsk(buildBrief(r))}>Brief me on them</button>
                    <button className="ghostbtn" onClick={() => void api.contactsForget(r.email).then(load)}>Forget</button>
                  </span>
                </div>

                {r.known && Object.keys(r.known).some((k) => k !== "email" && k !== "notes") && (
                  <div className="personknown">
                    {(["organisation", "role", "phone", "location"] as const).map((f) =>
                      r.known?.[f] ? <span key={f} className="knownbit"><b>{LABEL[f]}</b> {r.known[f]}</span> : null,
                    )}
                  </div>
                )}
                {r.known?.notes.map((n, i) => <div key={i} className="personnote">{n}</div>)}

                {r.pending.length > 0 && (
                  <div className="asklist">
                    <div className="hint">Forge AI thinks these might be true. They are not used until you say so.</div>
                    {r.pending.map((f) => (
                      <div key={f.id} className="askrow">
                        <span className="askfield">{LABEL[f.field] ?? f.field}</span>
                        <span className="askvalue">{f.value}</span>
                        <span className="hint asksrc">
                          from {f.last_source || f.source}
                          {f.times > 1 && ` · seen ${f.times}×`}
                        </span>
                        <span className="askacts">
                          <button className="ghostbtn" onClick={() => decide(r.email, f.id, "confirmed")}>Yes</button>
                          <button className="ghostbtn" onClick={() => decide(r.email, f.id, "rejected")}>No</button>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/** Only what was confirmed goes into the question. */
function buildBrief(r: ContactRow) {
  const k = r.known;
  const bits = k
    ? (["name", "organisation", "role", "phone", "location"] as const).filter((f) => k[f]).map((f) => `${LABEL[f]}: ${k[f]}`)
    : [];
  const notes = k?.notes ?? [];
  return [
    `Tell me what I should remember about ${k?.name || r.email} before I write to them.`,
    "",
    bits.length || notes.length
      ? `This is what I have confirmed about them:\n${[...bits, ...notes].join("\n")}`
      : "I have not confirmed anything about them yet.",
    "",
    "Use only what is above. If it is not enough to say anything useful, say that rather than guessing.",
  ].join("\n");
}
