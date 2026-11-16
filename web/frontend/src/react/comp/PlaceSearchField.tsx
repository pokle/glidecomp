/**
 * "Take me to…" for the route and waypoint editors' map.
 *
 * A RAC ComboBox over two sources: the competition's own waypoints, matched
 * locally on every keystroke (lib/waypoint-search.ts), and the Mapbox
 * Geocoding v6 forward endpoint (see lib/geocode.ts for why v6, and for the
 * temporary-tier rule that keeps every result display-only). Waypoints are
 * listed first: one the organiser loaded is a better answer than a town that
 * shares its name. Picking a row reports it; it never writes anything.
 *
 * Both `selectedKey` and `inputValue` are controlled, per RAC gotcha #12, which
 * makes the resets ours: `onSelectionChange(null)` is the Esc/blur revert and
 * restores the picked label rather than changing anything.
 *
 * Two things about this combobox are unlike the kit's usual advice, and both
 * come from the results being ASYNC and remote rather than a local array. They
 * are called out at their `allowsEmptyCollection` and `items` props below.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import {
  MIN_PLACE_QUERY_LENGTH,
  searchPlaces,
  type PlaceResult,
} from "@/react/lib/geocode";
import { searchWaypoints } from "@/react/lib/waypoint-search";
import type { MapWaypoint } from "@/analysis/map-provider";

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

/** Stable identities so the "just picked" render doesn't churn the collection. */
const NO_RESULTS: PlaceResult[] = [];
const NO_WAYPOINTS: MapWaypoint[] = [];
const NO_HITS: SearchHit[] = [];

type SearchState = "idle" | "searching" | "ready" | "error";

/** One row of the list: a waypoint of this competition, or a geocoded place. */
type SearchHit =
  | { kind: "waypoint"; id: string; waypoint: MapWaypoint }
  | { kind: "place"; id: string; place: PlaceResult };

/**
 * What the field shows once a row is picked. For a place, the full label, not
 * the bare name: six places are called Manilla and the reader deserves to know
 * which one the map just flew to. For a waypoint, its code and its name.
 */
function labelFor(hit: SearchHit): string {
  if (hit.kind === "waypoint") {
    const { code, name } = hit.waypoint;
    return name && name !== code ? `${code} – ${name}` : code;
  }
  const { place } = hit;
  return place.context ? `${place.name}, ${place.context}` : place.name;
}

export function PlaceSearchField({
  onPick,
  waypoints = NO_WAYPOINTS,
  onWaypointPick,
  isDisabled,
  className,
  placeholder,
}: {
  /** Called with the picked place so the caller can move its map. */
  onPick: (place: PlaceResult) => void;
  /** The waypoints on the map, searched by code and name ahead of places. */
  waypoints?: readonly MapWaypoint[];
  /** Called with the picked waypoint so the caller can move its map. */
  onWaypointPick?: (waypoint: MapWaypoint) => void;
  /** Set while there is no map to move yet, so a pick can't be dropped. */
  isDisabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>(NO_RESULTS);
  const [state, setState] = useState<SearchState>("idle");
  const hasWaypoints = waypoints.length > 0;

  /**
   * The place a pick settled on, held until the user edits the field again.
   * While it stands the search is settled — no request, no suggestions, popover
   * shut — and dropping it on the first edit is what lets the SAME place be
   * picked a second time (to fly back after panning away): RAC only reports a
   * selection when the key CHANGES, so the key has to return to null first.
   */
  const [picked, setPicked] = useState<SearchHit | null>(null);
  const settled = picked !== null && query === labelFor(picked);

  useEffect(() => {
    const q = query.trim();
    if (settled || q.length < MIN_PLACE_QUERY_LENGTH) {
      setResults(NO_RESULTS);
      setState("idle");
      return;
    }
    const controller = new AbortController();
    setState("searching");
    const timer = setTimeout(() => {
      searchPlaces(q, { signal: controller.signal })
        .then((places) => {
          setResults(places);
          setState("ready");
        })
        .catch((err: unknown) => {
          // Our own abort on the next keystroke — the newer search owns the
          // state now, so leave it alone.
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.warn("Place search failed:", err);
          setResults(NO_RESULTS);
          setState("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, settled]);

  // Latest handlers in refs so the pick path always calls the current closure.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onWaypointPickRef = useRef(onWaypointPick);
  onWaypointPickRef.current = onWaypointPick;

  // Local and instant, so no debounce and no minimum length: a code like "A1"
  // is short, and a one-letter query costs nothing to answer here.
  const items = useMemo((): SearchHit[] => {
    if (settled) return NO_HITS;
    const wps = searchWaypoints(query, waypoints).map(
      (waypoint): SearchHit => ({ kind: "waypoint", id: `waypoint:${waypoint.id}`, waypoint })
    );
    const places = results.map(
      (place): SearchHit => ({ kind: "place", id: `place:${place.id}`, place })
    );
    return wps.length || places.length ? [...wps, ...places] : NO_HITS;
  }, [settled, query, waypoints, results]);
  const searching = state === "searching";

  return (
    <ComboBox
      aria-label="Search for a place"
      placeholder={
        placeholder ??
        (hasWaypoints ? "Search waypoints, towns or regions…" : "Search for a town or region…")
      }
      isDisabled={isDisabled}
      className={className}
      inputValue={query}
      onInputChange={(value) => {
        // Any edit of our own label means the user is searching again.
        if (picked && value !== labelFor(picked)) setPicked(null);
        setQuery(value);
      }}
      selectedKey={picked?.id ?? null}
      onSelectionChange={(key) => {
        // Esc and the blur revert arrive here with no key. Nothing is selected
        // by then (editing dropped it), so this abandons the search — and
        // leaves the map wherever the last pick flew it.
        if (key == null) {
          setQuery(picked ? labelFor(picked) : "");
          return;
        }
        const hit = items.find((h) => h.id === String(key));
        if (!hit) return;
        setPicked(hit);
        setQuery(labelFor(hit));
        if (hit.kind === "waypoint") onWaypointPickRef.current?.(hit.waypoint);
        else onPickRef.current(hit.place);
      }}
      // Emptied the moment a pick settles, which is what CLOSES the popover:
      // RAC shuts a menu whose collection has gone empty, and its other close
      // path (the input text changing) does not fire when the picked label
      // happens to be what the user already typed.
      items={items}
      // Off once settled so that close can happen; on at every other time
      // because the results are ASYNC. RAC decides whether to open inside the
      // keystroke that changed the input, when the collection is still empty —
      // so gating this on "has a query", as a local-array combobox would,
      // swallows the open and the results then arrive with nowhere to land.
      // An empty input can't open the popover regardless (menuTrigger="input"
      // ignores a change to "").
      allowsEmptyCollection={!settled}
      renderEmptyState={() => (
        <div className="px-2 py-1.5 text-sm text-muted-foreground" role="status">
          {query.trim().length < MIN_PLACE_QUERY_LENGTH
            ? "Keep typing…"
            : searching
              ? "Searching…"
              : state === "error"
                ? hasWaypoints
                  ? "No waypoints match, and place search is unavailable right now."
                  : "Search is unavailable right now."
                : hasWaypoints
                  ? "No waypoints or places match."
                  : "No places match."}
        </div>
      )}
      listClassName="max-h-72"
    >
      {(hit: SearchHit) =>
        hit.kind === "waypoint" ? (
          <ComboBoxItem
            id={hit.id}
            textValue={labelFor(hit)}
            className="flex-col items-start gap-0"
          >
            <span className="truncate font-medium">{hit.waypoint.name || hit.waypoint.code}</span>
            <span className="truncate text-xs text-muted-foreground">
              Waypoint {hit.waypoint.code}
            </span>
          </ComboBoxItem>
        ) : (
          <ComboBoxItem
            id={hit.id}
            textValue={labelFor(hit)}
            className="flex-col items-start gap-0"
          >
            <span className="truncate font-medium">{hit.place.name}</span>
            {hit.place.context ? (
              <span className="truncate text-xs text-muted-foreground">{hit.place.context}</span>
            ) : null}
          </ComboBoxItem>
        )
      }
    </ComboBox>
  );
}
