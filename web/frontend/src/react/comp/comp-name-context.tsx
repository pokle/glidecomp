/**
 * The current competition's name, shared with the deep score tables so they can
 * build canonical `${slug}-${id}` pilot links (lib/slug.pilotPath) without
 * prop-drilling `compName` through every intermediate view.
 *
 * Provided once per scores surface — by ScoresViews (comp scores) and around
 * the task page's results (TaskDetail). Null when the name isn't loaded yet, in
 * which case the pilot link degrades to a bare comp segment and is canonicalised
 * on arrival by the pilot page's own useCanonicalPath hook + the server 301.
 */
import { createContext, useContext } from "react";

const CompNameContext = createContext<string | null>(null);

export const CompNameProvider = CompNameContext.Provider;

export function useCompName(): string | null {
  return useContext(CompNameContext);
}
