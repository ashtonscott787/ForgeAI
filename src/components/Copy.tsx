import { useState } from "react";

/** A copy button that confirms what it copied, because silence reads as failure. */
export function CopyButton({
  text,
  label,
  className = "ghostbtn",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`${className}${done ? " copied" : ""}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1400);
          })
          .catch(() => undefined);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}
