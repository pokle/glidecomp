/**
 * The prototype's stand-in for a route draft: one route in memory, shared by
 * the Route page and a turnpoint's page, with what was last "saved" beside it
 * so the Route page can say whether there is anything to save.
 *
 * The real editor keeps its draft in lib/draft-store.ts. This is only enough
 * of one to show where Save and Done sit.
 */
import { useSyncExternalStore } from "react";
import { ROUTE, type Turnpoint } from "./fixtures";

let saved: Turnpoint[] = ROUTE;
let draft: Turnpoint[] = ROUTE;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useRouteDraft(): { route: Turnpoint[]; dirty: boolean } {
  const route = useSyncExternalStore(subscribe, () => draft, () => draft);
  const clean = useSyncExternalStore(subscribe, () => saved, () => saved);
  return { route, dirty: route !== clean };
}

export function setRadius(id: string, radius: number): void {
  draft = draft.map((t) => (t.id === id ? { ...t, radius } : t));
  emit();
}

export function removeTurnpoint(id: string): void {
  draft = draft.filter((t) => t.id !== id);
  emit();
}

export function saveRoute(): void {
  saved = draft;
  emit();
}

export function discardRoute(): void {
  draft = saved;
  emit();
}
