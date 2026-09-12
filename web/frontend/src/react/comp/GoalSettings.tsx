/**
 * Goal settings — cylinder vs line, and the optional deadline.
 *
 * Shared by the route page's Goal disclosure and the last turnpoint's sheet,
 * so opening the goal and expanding the page panel edit the same state.
 */
import type { GoalConfig } from "@glidecomp/engine";
import { ChoiceList } from "@/react/rac/choice-list";
import { TimePicker } from "@/react/rac/date-picker";
import { Explain } from "@/react/rac/explain";

export function GoalSettings({
  goalType,
  onGoalTypeChange,
  deadline,
  onDeadlineChange,
  timeZoneLabel,
}: {
  goalType: GoalConfig["type"];
  onGoalTypeChange: (type: GoalConfig["type"]) => void;
  deadline: string;
  onDeadlineChange: (value: string) => void;
  timeZoneLabel: string;
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
