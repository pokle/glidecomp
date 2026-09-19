/**
 * Quick entry — the whole route as one line of text, at full screen.
 *
 * The expert's way in. Where the turnpoint list adds and edits one turnpoint
 * at a time, this takes a route the way a task setter says it out loud and
 * builds the lot in one go: "ell 400m ell 5k mitta cudg ncor 1k".
 *
 * It is a sheet reached from a button, rather than a field sitting in the
 * editor mirroring the route (#661). The line is a LOSSY view — it names
 * waypoints, radii, types and the start, and can say nothing about a
 * turnpoint's coordinates, altitude or long name — so a live mirror rebuilt
 * the route from the text on every pause in your typing, quietly discarding
 * exactly the details the line could not carry. Here, applying is a press you
 * meant to make, and it RECONCILES rather than rebuilds (route-reconcile.ts):
 * turnpoints the line still names keep their id, their position on the ground
 * and their elevation.
 *
 * The sheet opens showing the route that's loaded, so it edits a route as well
 * as enters one — and dismissing it without pressing keeps the route exactly
 * as it was.
 */
import { useMemo, useState } from "react";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import {
  FullScreenSheet,
  SheetBody,
  SheetHeader,
} from "@/react/rac/full-screen-sheet";
import { useConfirm } from "../lib/confirm";
import { quickTaskApply, type QuickTaskApply } from "./quick-task";
import { QuickTaskField } from "./QuickTaskField";

export function QuickEntrySheet({
  waypoints,
  defaultRadius,
  initialText,
  knownNames,
  openDistance,
  timeZoneLabel,
  onUse,
  onClose,
}: {
  waypoints: WaypointFileRecord[];
  defaultRadius: number;
  /** The route the editor holds, as a quick-task line. */
  initialText: string;
  /** Names of the turnpoints the route already holds (see quickTaskApply). */
  knownNames: string[];
  /** Open-distance comps have no speed section: one name, no start settings. */
  openDistance: boolean;
  /** Zone the start gates are read in; omitted for open distance. */
  timeZoneLabel?: string;
  onUse: (apply: QuickTaskApply) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [text, setText] = useState(initialText);

  // Stable identity: the field memoises its parse on this, and a fresh array
  // every render would re-parse the line on every keystroke of it.
  const known = useMemo(() => knownNames, [knownNames]);

  const parsed = useMemo(
    () => quickTaskApply(text, waypoints, { defaultRadius, knownNames: known }),
    [text, waypoints, defaultRadius, known]
  );

  /**
   * Leaving without pressing throws away the typing — so say so, but only
   * when there is typing to throw away. The sheet stays open when the reader
   * decides to keep editing: `FullScreenSheet` renders while it is mounted, so
   * declining simply means not unmounting it.
   */
  async function dismiss() {
    if (text === initialText) return onClose();
    const ok = await confirm({
      title: "Discard this text?",
      message:
        "The route in the editor hasn't changed. Anything typed here will be lost.",
      confirmLabel: "Discard",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (ok) onClose();
  }

  return (
    <FullScreenSheet
      label="Quick entry"
      onClose={() => void dismiss()}
      className="flex flex-col"
    >
      {/* Cancel and the commit sit on either side of the title, so the title
          is centred between them (SheetHeader's `align`). */}
      <SheetHeader
        title="Quick entry"
        align="center"
        leading={
          <Button variant="outline" onPress={() => void dismiss()}>
            Cancel
          </Button>
        }
        action={
          <Button
            isDisabled={parsed.picks.length === 0}
            onPress={() => {
              onUse(parsed);
              onClose();
            }}
          >
            Use this route
          </Button>
        }
      />

      <SheetBody className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Type the route the way you&apos;d say it — waypoint names in order,
          each with a radius (<span className="font-medium">400m</span>,{" "}
          <span className="font-medium">5k</span>) and, where position
          doesn&apos;t already say it, a type (
          <span className="font-medium">to</span>,{" "}
          <span className="font-medium">sss</span>,{" "}
          <span className="font-medium">ess</span>,{" "}
          <span className="font-medium">tp</span>,{" "}
          <span className="font-medium">goal</span>).
          {!openDistance ? (
            <>
              {" "}
              The start takes its settings the same way —{" "}
              <span className="font-medium">enter</span> or{" "}
              <span className="font-medium">exit</span>,{" "}
              <span className="font-medium">race</span> or{" "}
              <span className="font-medium">elapsed</span>, and any start gates
              as times: <span className="font-medium">sss enter 13:15 13:30</span>.
            </>
          ) : null}
        </p>

        <QuickTaskField
          waypoints={waypoints}
          defaultRadius={defaultRadius}
          value={text}
          onChange={setText}
          knownNames={known}
          placeholder={openDistance ? "ell 5k" : "ell 400m ell 5k mitta cudg ncor 1k"}
          exampleSize={openDistance ? 1 : undefined}
          timeZoneLabel={openDistance ? undefined : timeZoneLabel}
        />

        {/* What the line cannot say, said once — so nobody has to discover by
            losing an altitude that the grammar has no word for one. */}
        <p className="text-sm text-muted-foreground">
          Coordinates, altitude and full names stay as they are — this sets the
          order, waypoints, radii, types and the start.
        </p>
      </SheetBody>
    </FullScreenSheet>
  );
}
