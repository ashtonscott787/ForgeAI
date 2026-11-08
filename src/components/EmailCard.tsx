import type { EmailParts } from "../lib/blocks";
import { CopyButton } from "./Copy";

/**
 * A drafted email, with each part copyable on its own — recipients, subject
 * and body go into different boxes in every mail client, so they get different
 * buttons.
 */
export function EmailCard({ email }: { email: EmailParts }) {
  const full = [`To: ${email.to}`, email.cc ? `Cc: ${email.cc}` : null, `Subject: ${email.subject}`, "", email.body]
    .filter((l) => l !== null)
    .join("\n");

  return (
    <div className="emailcard">
      <div className="erow">
        <span className="elabel">To</span>
        <span className="evalue">{email.to}</span>
        <CopyButton text={email.to} label="Copy" />
      </div>
      {email.cc && (
        <div className="erow">
          <span className="elabel">Cc</span>
          <span className="evalue">{email.cc}</span>
          <CopyButton text={email.cc} label="Copy" />
        </div>
      )}
      <div className="erow">
        <span className="elabel">Subject</span>
        <span className="evalue">{email.subject}</span>
        <CopyButton text={email.subject} label="Copy" />
      </div>
      <div className="ebody">{email.body}</div>
      <div className="eactions">
        <CopyButton text={email.body} label="Copy message" className="primary" />
        <CopyButton text={full} label="Copy all" />
      </div>
    </div>
  );
}
