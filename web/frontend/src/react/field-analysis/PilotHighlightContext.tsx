/**
 * Cross-chart pilot highlight: hover or focus a pilot anywhere on the task
 * field-analysis page — a scatter dot, a heatmap row, a family-table row —
 * and they light up everywhere else.
 *
 * Keyed by trackFile (the project's pairing key). The default context is a
 * no-op so every consumer also works standalone, outside the provider —
 * components must never require the page to opt in.
 */
import { createContext, useContext, useMemo, useState } from "react";

interface PilotHighlight {
  highlight: string | null;
  setHighlight: (trackFile: string | null) => void;
}

const Ctx = createContext<PilotHighlight>({
  highlight: null,
  setHighlight: () => {},
});

export function usePilotHighlight(): PilotHighlight {
  return useContext(Ctx);
}

export function PilotHighlightProvider({ children }: { children: React.ReactNode }) {
  const [highlight, setHighlight] = useState<string | null>(null);
  const value = useMemo(() => ({ highlight, setHighlight }), [highlight]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
