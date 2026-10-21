/**
 * Goal settings — cylinder vs line, the optional deadline, and the
 * optional Elevated Goal height.
 *
 * Shared by the route page's Goal disclosure and the last turnpoint's sheet,
 * so opening the goal and expanding the page panel edit the same state.
 */
import type { GoalConfig } from "@glidecomp/engine";
import { ChoiceList } from "@/react/rac/choice-list";
import { TimePicker } from "@/react/rac/date-picker";
import { Explain } from "@/react/rac/explain";
import { AltitudeField } from "./fields";

export function GoalSettings({
  goalType,
  onGoalTypeChange,
  deadline,
  onDeadlineChange,
  timeZoneLabel,
  elevation,
  onElevationChange,
  goalAltitudeKnown,
}: {
  goalType: GoalConfig["type"];
  onGoalTypeChange: (type: GoalConfig["type"]) => void;
  deadline: string;
  onDeadlineChange: (value: string) => void;
  timeZoneLabel: string;
  /** Elevated Goal height above the goal turnpoint (m), NaN when off —
   *  the .xctsk `goal.finishAltitude` (S7F 2026 §6.2.3.2, issue #600). */
  elevation: number;
  onElevationChange: (metres: number) => void;
  /** Does the goal turnpoint have an altitude to measure the height from? */
  goalAltitudeKnown: boolean;
}) {
  return (
    <>
      <ChoiceList
        className="mt-2"
        label="Goal type"
        value={goalType}
        onChange={(v) => onGoalTypeChange(v as GoalConfig["type"])}
        options={[
          { value: "CYLINDER", label: "Cylinder — the last turnpoint's radius" },
          { value: "LINE", label: "Goal line — perpendicular to the last leg" },
        ]}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          Deadline — {timeZoneLabel}
          <TimePicker
            className="w-32"
            clearable
            aria-label={`Goal deadline — ${timeZoneLabel}`}
            value={deadline}
            onChange={onDeadlineChange}
          />
          {deadline ? null : "(optional)"}
        </span>
      </div>
      <div className="mt-3">
        <AltitudeField
          label="Elevated goal, height above goal"
          valueM={elevation}
          onChange={onElevationChange}
          description={
            goalAltitudeKnown
              ? "Optional (FAI S7F §6.2.3.2): 300 m is the standard height, 1,000 m the most. Any crossing reaches goal, but a pilot who crosses lower keeps only 80–100% of their time points. An elevated goal is also the end of the speed section."
              : "Optional (FAI S7F §6.2.3.2). Needs the goal turnpoint's altitude: without it, the height has nothing to be measured from and the goal is scored as an ordinary one."
          }
        />
      </div>
      {goalType === "LINE" ? (
        // Geometry an organiser reads once, so it sits on the ⓘ rather
        // than under the control every time the panel opens.
        <p className="mt-2 text-sm text-muted-foreground">
          <span className="inline-flex items-baseline gap-1">
            <span>Line length is 2 × the turnpoint&apos;s radius.</span>
            <Explain label="Goal line geometry" className="self-center">
              <p>
                The goal line is centred on the last turnpoint,
                perpendicular to the final leg, and extends the
                turnpoint&apos;s radius to each side.
              </p>
            </Explain>
          </span>
        </p>
      ) : null}
    </>
  );
}
