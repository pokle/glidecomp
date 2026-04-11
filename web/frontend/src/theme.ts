/**
 * Theme system — types, apply/save/load/export/import, shareable URL support.
 * Import this module from every page entry point to apply saved themes on load.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ThemeFont {
  family: string;
  weight: number;
  size: number;
  letterSpacing?: string;
  uppercase?: boolean;
}

export interface GlideCompTheme {
  name: string;
  author: string;
  version: 1;
  colors: {
    background: string;
    foreground: string;
    card: string;
    "card-foreground": string;
    popover: string;
    "popover-foreground": string;
    primary: string;
    "primary-foreground": string;
    secondary: string;
    "secondary-foreground": string;
    muted: string;
    "muted-foreground": string;
    accent: string;
    "accent-foreground": string;
    destructive: string;
    border: string;
    input: string;
    ring: string;
  };
  radius: string;
  buttonRadius: string;
  fonts: {
    heading: ThemeFont;
    body: ThemeFont;
    button: ThemeFont;
    caption: ThemeFont;
    nav: ThemeFont;
  };
}

export type ThemeColorKey = keyof GlideCompTheme["colors"];
export type ThemeFontRole = keyof GlideCompTheme["fonts"];

// ── Default theme (matches styles.css :root) ─────────────────────────────────

export const AVOCADO_THEME: GlideCompTheme = {
  name: "Avocado",
  author: "GlideComp",
  version: 1,
  colors: {
    background: "#152951",
    foreground: "#F4EAE4",
    card: "#1c3464",
    "card-foreground": "#F4EAE4",
    popover: "#1c3464",
    "popover-foreground": "#F4EAE4",
    primary: "#BCC817",
    "primary-foreground": "#152951",
    secondary: "#1c3464",
    "secondary-foreground": "#F4EAE4",
    muted: "#1c3464",
    "muted-foreground": "#a89f9a",
    accent: "#243d73",
    "accent-foreground": "#F4EAE4",
    destructive: "#f3727f",
    border: "#2d4a7a",
    input: "#1c3464",
    ring: "#BCC817",
  },
  radius: "0.5rem",
  buttonRadius: "9999px",
  fonts: {
    heading: { family: "Roboto", weight: 700, size: 24 },
    body: { family: "Roboto", weight: 400, size: 16 },
    button: { family: "Roboto", weight: 700, size: 14, letterSpacing: "0.014em", uppercase: true },
    caption: { family: "Roboto", weight: 400, size: 12 },
    nav: { family: "Roboto", weight: 600, size: 14 },
  },
};

export const BASECOAT_DARK_THEME: GlideCompTheme = {
  name: "Basecoat Dark",
  author: "Basecoat UI",
  version: 1,
  colors: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    card: "#171717",
    "card-foreground": "#fafafa",
    popover: "#262626",
    "popover-foreground": "#fafafa",
    primary: "#e5e5e5",
    "primary-foreground": "#171717",
    secondary: "#262626",
    "secondary-foreground": "#fafafa",
    muted: "#262626",
    "muted-foreground": "#a1a1a1",
    accent: "#404040",
    "accent-foreground": "#fafafa",
    destructive: "#ff6467",
    border: "#3a3a3a",
    input: "#454545",
    ring: "#737373",
  },
  radius: "0.625rem",
  buttonRadius: "8px",
  fonts: {
    heading: { family: "Inter", weight: 700, size: 24 },
    body: { family: "Inter", weight: 400, size: 16 },
    button: { family: "Inter", weight: 500, size: 14 },
    caption: { family: "Inter", weight: 400, size: 12 },
    nav: { family: "Inter", weight: 500, size: 14 },
  },
};

export const BASECOAT_LIGHT_THEME: GlideCompTheme = {
  name: "Basecoat Light",
  author: "Basecoat UI",
  version: 1,
  colors: {
    background: "#ffffff",
    foreground: "#0a0a0a",
    card: "#ffffff",
    "card-foreground": "#0a0a0a",
    popover: "#ffffff",
    "popover-foreground": "#0a0a0a",
    primary: "#171717",
    "primary-foreground": "#fafafa",
    secondary: "#f5f5f5",
    "secondary-foreground": "#171717",
    muted: "#f5f5f5",
    "muted-foreground": "#737373",
    accent: "#f5f5f5",
    "accent-foreground": "#171717",
    destructive: "#e7000b",
    border: "#e5e5e5",
    input: "#e5e5e5",
    ring: "#a1a1a1",
  },
  radius: "0.625rem",
  buttonRadius: "8px",
  fonts: {
    heading: { family: "Inter", weight: 700, size: 24 },
    body: { family: "Inter", weight: 400, size: 16 },
    button: { family: "Inter", weight: 500, size: 14 },
    caption: { family: "Inter", weight: 400, size: 12 },
    nav: { family: "Inter", weight: 500, size: 14 },
  },
};

const COLOR_KEYS: ThemeColorKey[] = Object.keys(AVOCADO_THEME.colors) as ThemeColorKey[];
const FONT_ROLES: ThemeFontRole[] = ["heading", "body", "button", "caption", "nav"];

// Fonts that are bundled locally (no Google Fonts load needed)
const LOCAL_FONTS = new Set(["Roboto", "Alte Haas Grotesk", "Atkinson Hyperlegible Next"]);

// Track which Google Font links we've already injected
const loadedGoogleFonts = new Set<string>();

// ── Storage ──────────────────────────────────────────────────────────────────

const STORAGE_KEY = "glidecomp:theme";

export function saveTheme(theme: GlideCompTheme): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
}

export function loadSavedTheme(): GlideCompTheme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) return parsed as GlideCompTheme;
  } catch { /* ignore corrupt data */ }
  return null;
}

export function resetTheme(): void {
  localStorage.removeItem(STORAGE_KEY);
  applyTheme(AVOCADO_THEME);
}

// ── Apply ────────────────────────────────────────────────────────────────────

function loadGoogleFont(family: string, weights: number[] = [400, 600, 700]): void {
  if (LOCAL_FONTS.has(family) || loadedGoogleFonts.has(family)) return;
  loadedGoogleFonts.add(family);

  const weightStr = weights.join(";");
  const encoded = encodeURIComponent(family);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@${weightStr}&display=swap`;
  document.head.appendChild(link);
}

export function applyTheme(theme: GlideCompTheme, target: HTMLElement = document.documentElement): void {
  // Colors
  for (const key of COLOR_KEYS) {
    target.style.setProperty(`--${key}`, theme.colors[key]);
  }

  // Radius
  target.style.setProperty("--radius", theme.radius);
  target.style.setProperty("--button-radius", theme.buttonRadius);

  // Fonts — set CSS variables and load Google Fonts as needed
  for (const role of FONT_ROLES) {
    const f = theme.fonts[role];
    const fallback = `'${f.family}', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
    target.style.setProperty(`--font-${role}`, fallback);
    target.style.setProperty(`--font-${role}-size`, `${f.size}px`);
    target.style.setProperty(`--font-${role}-weight`, String(f.weight));
    if (f.letterSpacing) {
      target.style.setProperty(`--font-${role}-letter-spacing`, f.letterSpacing);
    }
    if (f.uppercase !== undefined) {
      target.style.setProperty(`--font-${role}-transform`, f.uppercase ? "uppercase" : "none");
    }
    loadGoogleFont(f.family, [f.weight]);
  }
}

// ── Preload a Google Font for preview (e.g., in font picker dropdown) ────────

export function preloadFont(family: string): void {
  loadGoogleFont(family);
}

// ── Export / Import ──────────────────────────────────────────────────────────

export function exportTheme(theme: GlideCompTheme): void {
  const json = JSON.stringify(theme, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${theme.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.glidecomp-theme.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importTheme(file: File): Promise<GlideCompTheme> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string);
        if (parsed?.version !== 1 || !parsed?.colors || !parsed?.fonts) {
          reject(new Error("Invalid theme file format"));
          return;
        }
        // Ensure all required color keys exist
        for (const key of COLOR_KEYS) {
          if (typeof parsed.colors[key] !== "string") {
            reject(new Error(`Missing color: ${key}`));
            return;
          }
        }
        resolve(parsed as GlideCompTheme);
      } catch {
        reject(new Error("Could not parse theme file"));
      }
    };
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file);
  });
}

// ── Shareable URL ────────────────────────────────────────────────────────────

export function encodeThemeToURL(theme: GlideCompTheme, basePath: string = "/theme-editor"): string {
  const json = JSON.stringify(theme);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return `${window.location.origin}${basePath}#theme=${encoded}`;
}

export function decodeThemeFromHash(): GlideCompTheme | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#theme=")) return null;
  try {
    const encoded = hash.slice("#theme=".length);
    const json = decodeURIComponent(escape(atob(encoded)));
    const parsed = JSON.parse(json);
    if (parsed?.version === 1 && parsed?.colors && parsed?.fonts) {
      return parsed as GlideCompTheme;
    }
  } catch { /* ignore malformed URL */ }
  return null;
}

// ── Auto-apply on import ─────────────────────────────────────────────────────

function autoApply(): void {
  // URL hash theme takes priority (session-only preview)
  const hashTheme = decodeThemeFromHash();
  if (hashTheme) {
    applyTheme(hashTheme);
    return;
  }

  // Otherwise apply saved theme from localStorage
  const saved = loadSavedTheme();
  if (saved) {
    applyTheme(saved);
  }
}

autoApply();
