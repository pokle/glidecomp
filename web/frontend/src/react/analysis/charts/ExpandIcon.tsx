/** Four corners pushing out — the usual "make this bigger" glyph. Shared by
 * the link to a metric's full-size chart and the thermal map's maximise
 * control, so the affordance looks the same everywhere. */
export function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
