/**
 * Static list of popular Google Fonts (sorted by popularity).
 * Avoids needing a Google Fonts API key.
 * Font CSS is loaded at runtime from fonts.googleapis.com.
 */
export interface GoogleFontEntry {
  family: string;
  category: "sans-serif" | "serif" | "display" | "handwriting" | "monospace";
  variants: number[]; // available weights
}

export const LOCAL_FONTS: GoogleFontEntry[] = [
  { family: "Roboto", category: "sans-serif", variants: [400, 600, 700] },
  { family: "Alte Haas Grotesk", category: "sans-serif", variants: [400, 700] },
  { family: "Atkinson Hyperlegible Next", category: "sans-serif", variants: [400, 700] },
];

export const GOOGLE_FONTS: GoogleFontEntry[] = [
  { family: "Inter", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Open Sans", category: "sans-serif", variants: [400, 600, 700] },
  { family: "Lato", category: "sans-serif", variants: [400, 700] },
  { family: "Montserrat", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Poppins", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Nunito", category: "sans-serif", variants: [400, 600, 700] },
  { family: "Nunito Sans", category: "sans-serif", variants: [400, 600, 700] },
  { family: "Raleway", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Ubuntu", category: "sans-serif", variants: [400, 500, 700] },
  { family: "Quicksand", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Comfortaa", category: "display", variants: [400, 500, 600, 700] },
  { family: "Baloo 2", category: "display", variants: [400, 500, 600, 700] },
  { family: "Space Grotesk", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "DM Sans", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Cabin", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Outfit", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Lexend", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Rubik", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Work Sans", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Karla", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Josefin Sans", category: "sans-serif", variants: [400, 600, 700] },
  { family: "Libre Franklin", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Manrope", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Sora", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Plus Jakarta Sans", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Figtree", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Playfair Display", category: "serif", variants: [400, 500, 600, 700] },
  { family: "Merriweather", category: "serif", variants: [400, 700] },
  { family: "Lora", category: "serif", variants: [400, 500, 600, 700] },
  { family: "PT Serif", category: "serif", variants: [400, 700] },
  { family: "Libre Baskerville", category: "serif", variants: [400, 700] },
  { family: "Source Serif 4", category: "serif", variants: [400, 600, 700] },
  { family: "Pacifico", category: "handwriting", variants: [400] },
  { family: "Dancing Script", category: "handwriting", variants: [400, 500, 600, 700] },
  { family: "Caveat", category: "handwriting", variants: [400, 500, 600, 700] },
  { family: "Permanent Marker", category: "handwriting", variants: [400] },
  { family: "Architects Daughter", category: "handwriting", variants: [400] },
  { family: "Patrick Hand", category: "handwriting", variants: [400] },
  { family: "Indie Flower", category: "handwriting", variants: [400] },
  { family: "Shadows Into Light", category: "handwriting", variants: [400] },
  { family: "Fredoka", category: "sans-serif", variants: [400, 500, 600, 700] },
  { family: "Bubblegum Sans", category: "display", variants: [400] },
  { family: "Boogaloo", category: "display", variants: [400] },
  { family: "Chewy", category: "display", variants: [400] },
  { family: "Bangers", category: "display", variants: [400] },
  { family: "Righteous", category: "display", variants: [400] },
  { family: "Titan One", category: "display", variants: [400] },
  { family: "Lilita One", category: "display", variants: [400] },
  { family: "Russo One", category: "sans-serif", variants: [400] },
  { family: "Fira Code", category: "monospace", variants: [400, 500, 600, 700] },
  { family: "JetBrains Mono", category: "monospace", variants: [400, 500, 600, 700] },
  { family: "Source Code Pro", category: "monospace", variants: [400, 500, 600, 700] },
];

export const ALL_FONTS: GoogleFontEntry[] = [...LOCAL_FONTS, ...GOOGLE_FONTS];
