/**
 * Provider marks. Deliberately abstract geometry keyed by model family rather
 * than real company logos — a shipped product must not redistribute third-party
 * brand marks it has no licence for.
 */
export type MarkKind = "qwen" | "meta" | "ms" | "ds" | "generic";

export function Mark({ kind }: { kind: MarkKind }) {
  switch (kind) {
    case "qwen":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
          <path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" />
          <path d="M12 8.2l3.9 2.25v4.5L12 17.2l-3.9-2.25v-4.5z" fill="currentColor" stroke="none" opacity={0.45} />
        </svg>
      );
    case "meta":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path d="M3 15c0-5 2.2-8 4.8-8C11 7 12 12 12 12s1-5 4.2-5C18.8 7 21 10 21 15" />
        </svg>
      );
    case "ms":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <rect x="3.5" y="3.5" width="7.4" height="7.4" rx="1" />
          <rect x="13.1" y="3.5" width="7.4" height="7.4" rx="1" opacity={0.5} />
          <rect x="3.5" y="13.1" width="7.4" height="7.4" rx="1" opacity={0.5} />
          <rect x="13.1" y="13.1" width="7.4" height="7.4" rx="1" opacity={0.75} />
        </svg>
      );
    case "ds":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 3.8v16.4M3.8 12h16.4" opacity={0.4} />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <rect x="4" y="4" width="16" height="16" rx="4" />
        </svg>
      );
  }
}
