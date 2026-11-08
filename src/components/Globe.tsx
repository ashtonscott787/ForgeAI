/**
 * The Forge mark: a globe, drawn as vector so it stays crisp at every size and
 * can animate without a sprite. The slow rotation is CSS and respects the
 * system's reduced-motion setting.
 */
export function Globe({ size = 22, spin = false }: { size?: number; spin?: boolean }) {
  return (
    <span className={`globe${spin ? " spin" : ""}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <defs>
          <radialGradient id="fg-sphere" cx="34%" cy="28%" r="78%">
            <stop offset="0%" stopColor="#8fb6ff" />
            <stop offset="38%" stopColor="#6d7cf2" />
            <stop offset="68%" stopColor="#b06ae0" />
            <stop offset="100%" stopColor="#e88a6a" />
          </radialGradient>
          <radialGradient id="fg-shade" cx="50%" cy="50%" r="50%">
            <stop offset="62%" stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0.38)" />
          </radialGradient>
          <clipPath id="fg-clip">
            <circle cx="32" cy="32" r="26" />
          </clipPath>
        </defs>
        <circle cx="32" cy="32" r="26" fill="url(#fg-sphere)" />
        <g clipPath="url(#fg-clip)" fill="none" stroke="rgba(255,255,255,0.34)" strokeWidth="1.1">
          <ellipse cx="32" cy="32" rx="26" ry="10" />
          <ellipse cx="32" cy="32" rx="26" ry="19" />
          <ellipse cx="32" cy="32" rx="10" ry="26" />
          <ellipse cx="32" cy="32" rx="19" ry="26" />
          <line x1="6" y1="32" x2="58" y2="32" />
        </g>
        <circle cx="32" cy="32" r="26" fill="url(#fg-shade)" />
        <circle cx="32" cy="32" r="25.4" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.2" />
      </svg>
    </span>
  );
}
