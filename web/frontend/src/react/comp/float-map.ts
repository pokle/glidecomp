/**
 * A Mapbox map inside a floating detail (`components/FloatingWindow.tsx`):
 * which of the provider's own controls it keeps at each size. For the box
 * the map is mounted in.
 *
 * Whole class strings: Tailwind reads the source, not the running program.
 */
import type { FloatMode } from "../components/FloatingWindow";

/** The size buttons have the map's top right corner wherever it is shown, so
 * the provider's column of controls starts under them. */
const BELOW_SIZE_BUTTON =
  "[&_.mapboxgl-ctrl-top-right]:top-11! pointer-coarse:[&_.mapboxgl-ctrl-top-right]:top-12!";

export function floatMapClass(mode: FloatMode | null): string {
  switch (mode) {
    case "small":
    case "tucked":
      // A picture of the map alone, which takes no touch. The provider's
      // logo and attribution stay. A popup would not fit.
      return "[&_.mapboxgl-ctrl-top-left]:hidden [&_.mapboxgl-ctrl-top-right]:hidden [&_.mapboxgl-ctrl-bottom-left>*:not(:has(.mapboxgl-ctrl-logo))]:hidden [&_.ann-toggle]:hidden! [&_.mapboxgl-popup]:hidden";
    case "large":
      // The window is not large: the provider's zoom, compass, locate and
      // scale are dropped (owner's decision, 28 November 2026), and its
      // style and drawing controls stay.
      return "[&_.mapboxgl-ctrl-top-right]:hidden [&_.mapboxgl-ctrl-scale]:hidden";
    default:
      // The column, and the full-size page: everything.
      return BELOW_SIZE_BUTTON;
  }
}
