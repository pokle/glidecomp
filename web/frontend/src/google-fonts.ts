/**
 * Google Fonts loader — fetches the full font directory from Google's
 * public metadata endpoint at runtime. Falls back to a small built-in
 * list if the fetch fails.
 */
export interface GoogleFontEntry {
  family: string;
  category: string;
}

export const LOCAL_FONTS: GoogleFontEntry[] = [
  { family: "Roboto", category: "Sans Serif" },
  { family: "Alte Haas Grotesk", category: "Sans Serif" },
  { family: "Atkinson Hyperlegible Next", category: "Sans Serif" },
];

const FALLBACK_FONTS: GoogleFontEntry[] = [
  { family: "Inter", category: "Sans Serif" },
  { family: "Open Sans", category: "Sans Serif" },
  { family: "Montserrat", category: "Sans Serif" },
  { family: "Poppins", category: "Sans Serif" },
  { family: "Nunito", category: "Sans Serif" },
  { family: "Quicksand", category: "Sans Serif" },
  { family: "Comfortaa", category: "Display" },
  { family: "Noto Sans", category: "Sans Serif" },
  { family: "Noto Serif", category: "Serif" },
  { family: "Playfair Display", category: "Serif" },
  { family: "Lora", category: "Serif" },
  { family: "Caveat", category: "Handwriting" },
  { family: "Pacifico", category: "Handwriting" },
  { family: "Fira Code", category: "Monospace" },
];

let cachedFonts: GoogleFontEntry[] | null = null;

/**
 * Fetches the full Google Fonts directory (~1900 fonts).
 * Caches the result so subsequent calls are instant.
 * Falls back to a small built-in list on network failure.
 */
export async function fetchGoogleFonts(): Promise<GoogleFontEntry[]> {
  if (cachedFonts) return cachedFonts;

  try {
    const res = await fetch("https://fonts.google.com/metadata/fonts");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: { familyMetadataList?: { family: string; category: string }[] } = await res.json();
    const list: GoogleFontEntry[] = (data.familyMetadataList ?? []).map(
      (f: { family: string; category: string }) => ({
        family: f.family,
        category: f.category,
      })
    );
    if (list.length > 0) {
      cachedFonts = list;
      return list;
    }
  } catch {
    // Network failure — use fallback
  }

  cachedFonts = FALLBACK_FONTS;
  return FALLBACK_FONTS;
}

/** Returns all fonts: local fonts first, then Google Fonts. */
export async function getAllFonts(): Promise<GoogleFontEntry[]> {
  const google = await fetchGoogleFonts();
  return [...LOCAL_FONTS, ...google];
}
