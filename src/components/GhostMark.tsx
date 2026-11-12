/** The mark for a temporary chat: a ghost, because it leaves nothing behind. */
export function GhostMark({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M8 1.5A5 5 0 0 0 3 6.5v6.2c0 .5.6.8 1 .5l1-.8a.7.7 0 0 1 .9 0l.9.8a.7.7 0 0 0 .9 0l.9-.8a.7.7 0 0 1 .9 0l.9.8c.4.3 1 0 1-.5V6.5a5 5 0 0 0-5-5Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="6.3" cy="6.6" r=".85" fill="currentColor" />
      <circle cx="9.7" cy="6.6" r=".85" fill="currentColor" />
    </svg>
  );
}
