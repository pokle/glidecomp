/**
 * Cross-chart pilot highlight: hover or focus a pilot anywhere on the task
 * task-analysis page — a scatter dot, a heatmap row, a family-table row —
 * and they light up everywhere else.
 *
 * Two layers, one reading. `highlight` is what consumers tint by, and it is
 * the HOVERED pilot falling back to the PINNED one — the pilot picker pins a
 * selection that survives scrolling and re-lights the moment a passing hover
 * ends. Consumers don't know which layer lit them up, and don't need to:
 * hover writes through `setHighlight` exactly as before the pin existed, so
 * every pre-pin consumer works unchanged.
 *
 * Keyed by trackFile (the project's pairing key). The default context is a
 * no-op so every consumer also works standalone, outside the provider —
 * components must never require the page to opt in.
 */
import { createContext, useContext, useMemo, useState } from "react";

interface PilotHighlight {
  /** The pilot to tint: the hovered one, else the pinned one. */
  highlight: string | null;
  /** Transient hover/focus highlight; null on leave restores the pin. */
  setHighlight: (trackFile: string | null) => void;
  /** The picker's pinned pilot — null when nothing is pinned. */
  pinned: string | null;
  setPinned: (trackFile: string | null) => void;
}

const Ctx = createContext<PilotHighlight>({
  highlight: null,
  setHighlight: () => {},
  pinned: null,
  setPinned: () => {},
});

export function usePilotHighlight(): PilotHighlight {
  return useContext(Ctx);
}

export function PilotHighlightProvider({ children }: { children: React.ReactNode }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const value = useMemo(
    () => ({
      highlight: hovered ?? pinned,
      setHighlight: setHovered,
      pinned,
      setPinned,
    }),
    [hovered, pinned]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
