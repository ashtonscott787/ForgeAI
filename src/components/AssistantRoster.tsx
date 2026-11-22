import { ASSISTANTS, type Assistant } from "../lib/assistants";

/**
 * The assistants Forge AI comes with.
 *
 * A face, a name, what they do and how to address them. The point of the
 * portrait is not decoration: picking "Theo, looking things up" is a different
 * act from picking the third item in a list of configurations, and people are
 * much better at remembering the first.
 */
export function AssistantRoster({ onMessage }: { onMessage?: (a: Assistant) => void }) {
  return (
    <section className="roster" aria-label="Assistants">
      <h3 className="secthead">Your assistants</h3>
      <div className="roster-grid">
        {ASSISTANTS.map((a) => (
          <article key={a.id} className="person">
            <div className="person-top">
              {a.portrait ? (
                <img className="face" src={a.portrait} alt="" width={52} height={52} loading="lazy" />
              ) : (
                // No photograph exists for this one, so it is drawn as
                // initials rather than given an invented face.
                <span className="face initials" style={{ background: a.accent }} aria-hidden="true">
                  {a.initials}
                </span>
              )}
              <div className="person-id">
                <b>{a.name}</b>
                <span className="person-handle">{a.handle}</span>
                <span className="person-role">{a.role}</span>
              </div>
            </div>
            <p className="person-addr" title="An address inside Forge AI. It cannot receive mail from the internet.">
              {a.address}
            </p>
            <div className="person-acts">
              <button className="btn ghost small" onClick={() => onMessage?.(a)}>Message {a.name}</button>
            </div>
          </article>
        ))}
      </div>
      <p className="hint roster-note">
        These addresses work inside Forge AI only — they are not mailboxes and cannot receive mail from the
        internet. Messaging an assistant opens a chat with it; nothing is sent anywhere.
      </p>
    </section>
  );
}
