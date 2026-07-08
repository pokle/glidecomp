/**
 * Colour-scheme preference: Light, Dark or Auto (follow the OS). shadcn theming
 * keys dark mode off a `.dark` class on <html>; this module is the single owner
 * of that class for the SPA. The preference is persisted in localStorage under
 * `glidecomp-theme` and shared with the static (Astro) pages and the no-flash
 * inline head script in app.html, which all read/apply the same key.
 */
import { useSyncExternalStore } from "react";

export type ThemePreference = "light" | "dark" | "auto";

export const THEME_STORAGE_KEY = "glidecomp-theme";

// Guarded so this module is import-safe under SSR (workerd has no `window`):
// the four public pages' SSR bundle pulls in Settings (a route) → this module.
// The functions below only ever run in the browser (initTheme from the client
// entry, the useTheme hooks after hydration), so null here is only the
// module-load state on the server.
const darkQuery =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<() => void>();

export function getStoredTheme(): ThemePreference {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

/** Whether the given preference resolves to dark right now (Auto follows the OS). */
function resolvesToDark(pref: ThemePreference): boolean {
  return pref === "dark" || (pref === "auto" && !!darkQuery?.matches);
}

function applyTheme(pref: ThemePreference): void {
  document.documentElement.classList.toggle("dark", resolvesToDark(pref));
}

export function setStoredTheme(pref: ThemePreference): void {
  localStorage.setItem(THEME_STORAGE_KEY, pref);
  applyTheme(pref);
  listeners.forEach((fn) => fn());
}

/**
 * Apply the stored preference and keep the `.dark` class in sync with OS changes
 * (only relevant while in Auto) and with the preference being changed in another
 * tab. Call once at app startup.
 */
export function initTheme(): void {
  applyTheme(getStoredTheme());
  darkQuery?.addEventListener("change", () => {
    if (getStoredTheme() === "auto") applyTheme("auto");
    listeners.forEach((fn) => fn());
  });
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_STORAGE_KEY) {
      applyTheme(getStoredTheme());
      listeners.forEach((fn) => fn());
    }
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React binding: current preference plus a setter that persists and applies it. */
export function useTheme(): [ThemePreference, (pref: ThemePreference) => void] {
  const theme = useSyncExternalStore(subscribe, getStoredTheme, () => "auto" as const);
  return [theme, setStoredTheme];
}
