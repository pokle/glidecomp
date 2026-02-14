# Leaflet 2.0 Provider - Implementation Notes

Technical notes and bug fixes from implementing the Leaflet 2.0.0-alpha.1 map provider.

## Canvas Renderer Bug (alpha.1)

**Symptom:** With `preferCanvas: true`, canvas-drawn elements (Polyline, Polygon) rendered to the top-left corner of the map, while DOM-based elements (Marker, DivIcon, Tooltip) rendered at correct positions.

**Root cause:** The Canvas renderer's `_resizeContainer` method (in `BlanketOverlay._onMoveEnd`) unconditionally clears the canvas by setting width/height attributes on every `moveend` event. This destroys the coordinate transform set by `_update()`. The SVG renderer has a guard (`if (!this._svgSize || !this._svgSize.equals(size))`) that prevents this.

**Fix:** Removed `preferCanvas: true` from LeafletMap options, falling back to the default SVG renderer.

**Status:** Reported as [Leaflet/Leaflet#10061](https://github.com/Leaflet/Leaflet/issues/10061), fixed on main branch, expected to ship in alpha.2. Re-test `preferCanvas: true` after upgrading.

## Z-Index Stacking: Leaflet Map Overlaying Sidebar

**Symptom:** The Leaflet map appeared on top of the sidebar event panel, making the panel unclickable. The sidebar was open (transform: none, aria-hidden: false) but invisible behind the map.

**Root cause:** Leaflet's CSS assigns high internal z-indices to its panes:

| Element | z-index |
|---------|---------|
| `.leaflet-pane` | 400 |
| `.leaflet-marker-pane` | 600 |
| `.leaflet-tooltip-pane` | 650 |
| `.leaflet-popup-pane` | 700 |
| `.leaflet-control` | 800 |
| `.leaflet-top, .leaflet-bottom` | 1000 |

The `#map` element had `position: absolute` with `z-index: auto`, which does **not** create a stacking context. This meant Leaflet's internal z-indices (400-1000) competed directly with the sidebar's Tailwind `z-40` (z-index: 40) in the same stacking context, and Leaflet won.

MapBox doesn't have this problem because it uses canvas/WebGL rendering without high CSS z-indices.

**Fix:** Added `z-index: 0` to the `#map` CSS rule. This creates a stacking context that contains all of Leaflet's internal z-indices, keeping them from escaping. The sidebar's z-40 is now properly above the map's z-0.

**Key takeaway:** When embedding Leaflet in a page with other positioned/z-indexed elements, always set an explicit z-index on the map container to create a stacking context.

## SVG Pointer Events: Track Click Not Working

**Symptom:** Clicking on the track polyline did nothing — no event was selected in the panel.

**Root cause:** Two issues combined:

1. **Gradient track polylines had `interactive: false`:** When altitude colors mode is active, the solid track group is hidden and the gradient group is shown. The gradient group's outline and all ~500 segment polylines were created with `interactive: false`.

2. **Leaflet SVG pointer-events architecture:** Leaflet's CSS sets `pointer-events: none` on all SVG paths by default, then overrides with `pointer-events: auto` only for paths with the `leaflet-interactive` class:

   ```css
   .leaflet-pane > svg path { pointer-events: none; }
   .leaflet-pane > svg path.leaflet-interactive { pointer-events: auto; }
   ```

   The SVG renderer only adds `leaflet-interactive` to paths where `options.interactive` is true (SVG.js line 93-94). Without this class, clicks pass through the path entirely.

**How Leaflet SVG click detection works:**
- The map registers click listeners on its container element
- When a click occurs, `_findEventTargets` walks up from `e.target` (the DOM element that received the click)
- It looks up each element in `this._targets` (populated by `addInteractiveTarget`) to find the matching layer
- For this to work, `e.target` must be the SVG `<path>` element, which requires `pointer-events: auto` (i.e., the `leaflet-interactive` class)

**Fix:** Made the gradient outline polyline interactive (removed `interactive: false`) and bound the track click handler to it. The ~500 gradient segment polylines remain non-interactive for performance — their `pointer-events: none` lets clicks pass through to the interactive outline underneath.

**Key takeaway:** In Leaflet's SVG renderer, any path you want to be clickable must have `interactive: true` (the default). Setting `interactive: false` removes the `leaflet-interactive` class, which makes the path invisible to pointer events. For multi-layer tracks (outline + colored segments), make the full-length outline interactive and keep the visual segments non-interactive.

## Tailwind CSS Interaction with Leaflet

Tailwind's preflight styles affect Leaflet elements:

- **Canvas:** `display: block; vertical-align: middle` — does NOT set `max-width: 100%` (that's only on `img, video`), so canvas sizing is unaffected
- **Leaflet CSS priority:** Leaflet's CSS is unlayered (imported directly), so it has higher specificity than Tailwind's `@layer base` styles

Dark mode overrides for Leaflet controls need to be placed outside `@layer` blocks in `styles.css` to override Leaflet's own CSS. We use CSS custom properties (`var(--background)`, `var(--foreground)`, etc.) for theming consistency.

## Turnpoint Labels: DivIcon vs Tooltip

**Symptom:** Turnpoint name labels rendered inside a white rectangular box (Leaflet's default tooltip styling), obscuring the map underneath.

**Root cause:** `bindTooltip()` wraps content in Leaflet's `.leaflet-tooltip` container which has background, border, box-shadow, and a `::before` pseudo-element arrow. Overriding all of this via CSS requires multiple `!important` rules and still leaves artifacts (the tooltip container div with padding/layout).

**Fix:** Replaced `bindTooltip()` with a `DivIcon` marker using inline text-shadow for readability — the same approach used for leg distance labels:

```typescript
const labelIcon = new DivIcon({
  html: `<div style="
    font-size: 12px; font-weight: 600; color: #1e293b;
    white-space: nowrap;
    text-shadow: -1px -1px 2px white, 1px -1px 2px white,
                 -1px 1px 2px white, 1px 1px 2px white, 0 0 4px white;
  ">${label}</div>`,
  className: '',   // prevents Leaflet's default marker styling
  iconSize: [0, 0],
  iconAnchor: [0, 12],  // offset above the turnpoint dot
});
taskGroup.addLayer(new Marker(latlng, { icon: labelIcon, interactive: false }));
```

**Key takeaway:** For text-only labels on a Leaflet map, prefer `DivIcon` with `className: ''` over `bindTooltip({ permanent: true })`. DivIcon gives full control over styling with no Leaflet CSS to fight against. Use multi-directional text-shadow as a lightweight halo for readability over varied map backgrounds.

## Leaflet 2.0 ESM API

Leaflet 2.0 uses ESM imports with `new` constructors instead of the `L.marker()` factory pattern:

```typescript
import { Map as LeafletMap, TileLayer, Polyline, Polygon, CircleMarker,
         Marker, DivIcon, Tooltip, Popup, LayerGroup, Control,
         LatLngBounds } from 'leaflet';

const map = new LeafletMap(container, options);
const polyline = new Polyline(latlngs, options);
const marker = new Marker(latlng, { icon: new DivIcon({ html: '...' }) });
```

Other 2.0 changes:
- `bubblingMouseEvents` renamed to `bubblingPointerEvents`
- Pointer Events API replaces mouse/touch events
- No built-in TypeScript types in alpha.1 — custom `leaflet.d.ts` declarations required
- LatLng array order is `[lat, lng]` (index 0 = latitude, index 1 = longitude)
