/**
 * "Find a pilot" — pins one pilot's highlight across every chart and table
 * on the task-analysis page.
 *
 * The hover-highlight (PilotHighlightContext) already threads through the
 * heatmap, the rank scatters, the cluster cards and every family table, but
 * it dies the moment the pointer moves on. Pinning is what turns 19,000 px
 * of field data into one pilot's story: pick yourself here and you stay lit
 * for the whole read. A passing hover still takes over momentarily — the
 * page stays explorable — and the pin re-lights when it ends. The diamond
 * next to the field is the same mark the scatter draws on that pilot.
 *
 * THE URL IS THE ONLY SOURCE OF TRUTH for the pin: `?pilot=<name>`, like the
 * class in `?class=`, so a pilot can be handed a link to their own reading
 * of the task. Picking and clearing WRITE the parameter; a single effect
 * resolves parameter → context pin. Never set the pin directly beside a
 * setSearchParams call: `searchParams` updates a commit later than local
 * state, so a second writer reads the stale parameter and resurrects the
 * pin you just cleared (the ✕ did exactly that in the first cut).
 *
 * The name rather than the trackFile: this is view state, and a URL a
 * person can read beats an internal filename. Matching is exact — two
 * pilots sharing one name resolve to the first, an accepted view-state
 * compromise — and a stale name (class switch, recompute that dropped the
 * pilot) clears pin and parameter rather than pinning nobody-in-particular.
 *
 * Both `selectedKey` and `inputValue` are controlled, per RAC gotcha #12.
 * Clearing the pin is the ✕ button alone (tabbable, so keyboard-reachable):
 * with the popover shut, RAC fires no revert on Esc or blur, so an
 * "empty-the-field-means-clear" pathway cannot be made reliable — instead
 * blur simply snaps the field back to the pinned name (or empty), and no
 * half-typed text is ever left looking like a selection. The ✕ sits outside
 * the combobox because react-aria hides any in-group button from AT while
 * the popover is open (see rac/combo-box.tsx).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useFilter } from "react-aria-components";
import { XIcon } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import { Button } from "@/react/rac/button";
import { usePilotHighlight } from "./PilotHighlightContext";
import { PilotHighlightLegend } from "./PilotHighlightMark";

interface PickerPilot {
  trackFile: string;
  pilotName: string;
  rank: number;
}

/** The URL parameter the pin round-trips through. */
export const PILOT_PARAM = "pilot";

export function PilotPicker({ pilots }: { pilots: PickerPilot[] }) {
  const { pinned, setPinned } = usePilotHighlight();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState("");

  const pinnedPilot = pilots.find((p) => p.trackFile === pinned) ?? null;

  // Latest pinned name for the deferred blur handler below — a blur snaps
  // the field back to the truth one frame later (so a click-pick's selection
  // lands first), and a frame-old closure would snap it to the wrong truth.
  const pinnedNameRef = useRef<string | null>(null);
  pinnedNameRef.current = pinnedPilot?.pilotName ?? null;

  /** Write the pin's one source of truth; the effect below applies it. */
  function writeParam(name: string | null) {
    const next = new URLSearchParams(searchParams);
    if (name) next.set(PILOT_PARAM, name);
    else next.delete(PILOT_PARAM);
    setSearchParams(next, { replace: true });
  }

  // Parameter → pin, the only writer of the context's pinned value. Also
  // covers load (the shared-link case) and a roster swap under the pin (a
  // class switch): the pilot resolves in the new roster or the pin clears.
  // The query is only touched when the resolved pin CHANGES, so it never
  // stomps mid-typing (typing changes neither dependency).
  useEffect(() => {
    const wanted = searchParams.get(PILOT_PARAM);
    const match = wanted ? (pilots.find((p) => p.pilotName === wanted) ?? null) : null;
    if (wanted && !match) {
      // A name this report doesn't hold must not stay in the address bar
      // looking like it did something.
      const next = new URLSearchParams(searchParams);
      next.delete(PILOT_PARAM);
      setSearchParams(next, { replace: true });
      return;
    }
    const target = match?.trackFile ?? null;
    if (target !== pinned) {
      setPinned(target);
      setQuery(match?.pilotName ?? "");
    }
    // setSearchParams/setPinned are stable; pinned converges (guarded set).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilots, searchParams, pinned]);

  // Local filter over the analysed roster. Empty query → empty list, so the
  // popover stays shut at rest (the kit's convention); the settled state —
  // input showing exactly the pinned name — also stays shut, or the popover
  // would reopen over the page every time focus returns to the field.
  const { contains } = useFilter({ sensitivity: "base" });
  const settled = pinnedPilot !== null && query === pinnedPilot.pilotName;
  const matches = useMemo(() => {
    const q = query.trim();
    if (q.length === 0 || settled) return [];
    return pilots.filter((p) => contains(p.pilotName, q));
    // `contains` is stable per locale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pilots, query, settled]);

  return (
    <div className="flex items-center gap-1.5">
      {/* Same diamond the scatter draws on the pinned pilot — a legend, not
          a second control. aria-hidden: the combobox already names the
          action. */}
      <PilotHighlightLegend />
      <ComboBox
        aria-label="Highlight a pilot"
        placeholder="Highlight a pilot…"
        className="w-56"
        items={matches}
        inputValue={query}
        onInputChange={setQuery}
        selectedKey={pinned}
        allowsEmptyCollection={query.trim().length > 0 && !settled}
        renderEmptyState={() => (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">
            No pilot in this analysis matches.
          </p>
        )}
        onFocusChange={(focused) => {
          if (focused) return;
          // Snap the field back to the truth. Deferred a frame so that when
          // the blur IS a click on an option, the selection commits first —
          // and even then the URL-resolve effect re-asserts the final text.
          requestAnimationFrame(() => setQuery(pinnedNameRef.current ?? ""));
        }}
        onSelectionChange={(key) => {
          if (key === null) {
            // RAC's revert (fires with the popover open): restore the
            // pinned name — clearing is the ✕'s job alone.
            setQuery(pinnedPilot?.pilotName ?? "");
            return;
          }
          const pilot = pilots.find((p) => p.trackFile === key);
          if (pilot) writeParam(pilot.pilotName);
        }}
      >
        {(pilot: PickerPilot) => (
          <ComboBoxItem key={pilot.trackFile} id={pilot.trackFile} textValue={pilot.pilotName}>
            <span className="truncate">{pilot.pilotName}</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              #{pilot.rank}
            </span>
          </ComboBoxItem>
        )}
      </ComboBox>
      {pinnedPilot ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Stop highlighting ${pinnedPilot.pilotName}`}
          onPress={() => writeParam(null)}
        >
          <XIcon aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}
