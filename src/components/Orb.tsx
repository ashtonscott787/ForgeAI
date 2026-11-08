/**
 * The Forge AI mark, drawn from the supplied artwork: a lit sphere with the
 * four colour fields in the original. Vector, so it stays sharp at any size,
 * and it reads on light and dark backgrounds alike.
 */
export function Orb({ size = 22, spin = false }: { size?: number; spin?: boolean }) {
  return (
    <span className={`orb${spin ? " live" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id="fo-base" x1="0" y1="0" x2="0.34" y2="0.94">
            <stop offset="0" stopColor="#5e5ce6" />
            <stop offset="1" stopColor="#2f6df6" />
          </linearGradient>
          <radialGradient id="fo-violet" cx="0.30" cy="0.30" r="0.60">
            <stop offset="0" stopColor="#bf5af2" />
            <stop offset="1" stopColor="#bf5af2" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="fo-blue" cx="0.24" cy="0.72" r="0.58">
            <stop offset="0" stopColor="#2f6df6" />
            <stop offset="1" stopColor="#2f6df6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="fo-pink" cx="0.78" cy="0.30" r="0.55">
            <stop offset="0" stopColor="#ff375f" />
            <stop offset="1" stopColor="#ff375f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="fo-amber" cx="0.80" cy="0.78" r="0.50">
            <stop offset="0" stopColor="#ff9f0a" />
            <stop offset="1" stopColor="#ff9f0a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="fo-shine" cx="0.34" cy="0.26" r="0.26">
            <stop offset="0" stopColor="#fff" stopOpacity="0.85" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="50" fill="url(#fo-base)" />
        <circle cx="50" cy="50" r="50" fill="url(#fo-violet)" />
        <circle cx="50" cy="50" r="50" fill="url(#fo-blue)" />
        <circle cx="50" cy="50" r="50" fill="url(#fo-pink)" />
        <circle cx="50" cy="50" r="50" fill="url(#fo-amber)" />
        <circle cx="50" cy="50" r="50" fill="url(#fo-shine)" />
      </svg>
    </span>
  );
}
