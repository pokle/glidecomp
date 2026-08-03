/**
 * "Take me to…" for the route and waypoint editors' map.
 *
 * A RAC ComboBox over the Mapbox Geocoding v6 forward endpoint (see
 * lib/geocode.ts for why v6, and for the temporary-tier rule that keeps every
 * result display-only). Picking a row reports the place; it never writes one.
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

/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 300;

/** Stable identity so the "just picked" render doesn't churn the collection. */
const NO_RESULTS: PlaceResult[] = [];

type SearchState = "idle" | "searching" | "ready" | "error";

/**
 * What the field shows once a place is picked. The full label, not the bare
 * name: six places are called Manilla and the reader deserves to know which one
 * the map just flew to.
 */
function labelFor(place: PlaceResult): string {
  return place.context ? `${place.name}, ${place.context}` : place.name;
}

export function PlaceSearchField({
  onPick,
  isDisabled,
  className,
  placeholder = "Search for a town or region…",
}: {
  /** Called with the picked place so the caller can move its map. */
  onPick: (place: PlaceResult) => void;
  /** Set while there is no map to move yet, so a pick can't be dropped. */
  isDisabled?: boolean;
  className?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[]>(NO_RESULTS);
  const [state, setState] = useState<SearchState>("idle");

  /**
   * The place a pick settled on, held until the user edits the field again.
   * While it stands the search is settled — no request, no suggestions, popover
   * shut — and dropping it on the first edit is what lets the SAME place be
   * picked a second time (to fly back after panning away): RAC only reports a
   * selection when the key CHANGES, so the key has to return to null first.
   */
  const [picked, setPicked] = useState<PlaceResult | null>(null);
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

  // Latest handler in a ref so the pick path always calls the current closure.
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const items = useMemo(() => (settled ? NO_RESULTS : results), [settled, results]);
  const searching = state === "searching";

  return (
    <ComboBox
      aria-label="Search for a place"
      placeholder={placeholder}
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
        const place = results.find((p) => p.id === String(key));
        if (!place) return;
        setPicked(place);
        setQuery(labelFor(place));
        onPickRef.current(place);
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
                ? "Search is unavailable right now."
                : "No places match."}
        </div>
      )}
      listClassName="max-h-72"
    >
      {(place: PlaceResult) => (
        <ComboBoxItem
          id={place.id}
          textValue={labelFor(place)}
          className="flex-col items-start gap-0"
        >
          <span className="truncate font-medium">{place.name}</span>
          {place.context ? (
            <span className="truncate text-xs text-muted-foreground">{place.context}</span>
          ) : null}
        </ComboBoxItem>
      )}
    </ComboBox>
  );
}
