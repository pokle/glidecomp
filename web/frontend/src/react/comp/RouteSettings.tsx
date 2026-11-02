/**
 * The task's start (SSS) and goal settings, bound to the route DRAFT
 * (comp/route-draft.ts). They are task-level, not a property of any one
 * turnpoint, but they are edited in two places: the route page's Start and
 * Goal sections, and the page of the turnpoint they belong to (the start
 * cylinder and the last one), which is where an organiser who opened that
 * cylinder looks. Both write straight into the draft, so the two can never
 * disagree.
 */
import { useState } from "react";
import { StartSettings } from "./StartSettings";
import { GoalSettings } from "./GoalSettings";
import { addMinutes } from "./route-editor";
import { missingAltitude } from "./turnpoint-draft";
import type { RouteEditorState } from "./use-route-editor";

export function RouteStartSettings({
  editor,
  missingSssWarning,
}: {
  editor: RouteEditorState;
  /** The route page's section only: the route has no SSS turnpoint for these gates. */
  missingSssWarning?: boolean;
}) {
  const { draft, update } = editor;
  // The series generator's inputs. Not part of the route: nothing is saved
  // from them until "Generate" writes the gates.
  const [genCount, setGenCount] = useState(4);
  const [genInterval, setGenInterval] = useState(15);
  const interval = Number.isFinite(genInterval) && genInterval > 0 ? genInterval : 15;

  return (
    <StartSettings
      sssType={draft.sssType}
      onSssTypeChange={(sssType) => update((d) => ({ ...d, sssType }))}
      direction={draft.direction}
      onDirectionChange={(direction) => update((d) => ({ ...d, direction }))}
      gates={draft.gates}
      onGateChange={(index, value) =>
        update((d) => ({ ...d, gates: d.gates.map((g, i) => (i === index ? value : g)) }))
      }
      onRemoveGate={(index) =>
        update((d) => ({ ...d, gates: d.gates.filter((_, i) => i !== index) }))
      }
      onAddGate={() =>
        update((d) => {
          const last = d.gates[d.gates.length - 1];
          return { ...d, gates: [...d.gates, last ? addMinutes(last, interval) : "12:00"] };
        })
      }
      genCount={genCount}
      onGenCountChange={setGenCount}
      genInterval={genInterval}
      onGenIntervalChange={setGenInterval}
      onGenerateSeries={() =>
        update((d) => {
          const count = Math.min(Math.max(Number.isFinite(genCount) ? genCount : 0, 1), 100);
          const first = d.gates[0] ?? "12:00";
          return {
            ...d,
            gates: Array.from({ length: count }, (_, i) => addMinutes(first, i * interval)),
          };
        })
      }
      timeZoneLabel={editor.timeZoneLabel}
      timeZoneKnown={editor.tz != null}
      missingSssWarning={missingSssWarning}
    />
  );
}

export function RouteGoalSettings({ editor }: { editor: RouteEditorState }) {
  const { draft, update } = editor;
  return (
    <GoalSettings
      goalType={draft.goalType}
      onGoalTypeChange={(goalType) => update((d) => ({ ...d, goalType }))}
      deadline={draft.goalDeadline}
      onDeadlineChange={(goalDeadline) => update((d) => ({ ...d, goalDeadline }))}
      timeZoneLabel={editor.timeZoneLabel}
      elevation={draft.goalElevation ?? NaN}
      onElevationChange={(m) =>
        update((d) => ({ ...d, goalElevation: Number.isFinite(m) ? m : null }))
      }
      goalAltitudeKnown={!missingAltitude(draft.rows[draft.rows.length - 1]?.altitude ?? "")}
    />
  );
}
