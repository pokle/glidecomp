/**
 * Start (SSS) settings — type, direction and gates.
 *
 * Shared by the route page's Start disclosure and the turnpoint sheet, so
 * opening the start cylinder and expanding the page panel edit the same
 * state and cannot drift.
 */
import type { SSSConfig } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { ChoiceList } from "@/react/rac/choice-list";
import { NumberField } from "@/react/rac/field";
import { TimePicker } from "@/react/rac/date-picker";

export function StartSettings({
  sssType,
  onSssTypeChange,
  direction,
  onDirectionChange,
  gates,
  onGateChange,
  onRemoveGate,
  onAddGate,
  genCount,
  onGenCountChange,
  genInterval,
  onGenIntervalChange,
  onGenerateSeries,
  timeZoneLabel,
  timeZoneKnown,
  missingSssWarning,
}: {
  sssType: SSSConfig["type"];
  onSssTypeChange: (type: SSSConfig["type"]) => void;
  direction: SSSConfig["direction"];
  onDirectionChange: (direction: SSSConfig["direction"]) => void;
  gates: string[];
  onGateChange: (index: number, value: string) => void;
  onRemoveGate: (index: number) => void;
  onAddGate: () => void;
  genCount: number;
  onGenCountChange: (n: number) => void;
  genInterval: number;
  onGenIntervalChange: (n: number) => void;
  onGenerateSeries: () => void;
  timeZoneLabel: string;
  /** Comp timezone is set — gates are edited in that zone, not UTC. */
  timeZoneKnown: boolean;
  /** Page panel only: the route has no SSS turnpoint for these gates. */
  missingSssWarning?: boolean;
}) {
  const isRace = sssType === "RACE";

  return (
    <>
      {missingSssWarning ? (
        <p className="mt-1 text-sm text-amber-500">
          ⚠ This task has no Start (SSS) turnpoint — set one in the list
          above, otherwise gates have no cylinder to apply to.
        </p>
      ) : null}
      {/* Lists in flow, not popovers (#638). Both choices are two-way and
          each option carries an explanation, which a collapsed select shows
          one of and hides the other — here they are side by side, which is
          how you choose between them. */}
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <ChoiceList
          label="Start type"
          value={sssType}
          onChange={(v) => onSssTypeChange(v as SSSConfig["type"])}
          options={[
            { value: "RACE", label: "Race to goal — timed from a start gate" },
            {
              value: "ELAPSED-TIME",
              label: "Elapsed time — timed from each pilot's crossing",
            },
          ]}
        />
        <ChoiceList
          label="Start direction"
          value={direction}
          onChange={(v) => onDirectionChange(v as SSSConfig["direction"])}
          options={[
            { value: "EXIT", label: "Exit start — cross outward" },
            { value: "ENTER", label: "Enter start — cross inward" },
          ]}
        />
      </div>

      <h4 className="mt-3 text-sm font-medium">
        {isRace ? `Start gates — ${timeZoneLabel}` : `Start open — ${timeZoneLabel}`}
      </h4>
      <p className="mt-1 text-sm text-muted-foreground">
        {isRace
          ? "A pilot's start time is the last gate at or before their start crossing (FAI S7F §9.2.4.1). Starting before the first gate is an early start."
          : "Elapsed-time pilots are timed from their actual start crossing; a gate only sets when the start opens."}{" "}
        {timeZoneKnown
          ? "Times are comp-local (set in Competition Settings)."
          : "Times are UTC — save a route (or set a timezone in Competition Settings) to edit in comp-local time."}
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {gates.map((g, i) => (
          <li key={i} className="flex items-center gap-2">
            <TimePicker
              className="w-32"
              required
              aria-label={`Gate ${i + 1} time — ${timeZoneLabel}`}
              value={g}
              onChange={(v) => onGateChange(i, v)}
            />
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onPress={() => onRemoveGate(i)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {isRace && gates.length === 0 ? (
        <p className="mt-2 text-sm text-amber-500">
          ⚠ No start gates — every pilot will be timed from their actual
          start crossing, like an elapsed-time task.
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onPress={onAddGate}>
          + Add gate
        </Button>
        {isRace ? (
          <span className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            <NumberField
              minValue={1}
              maxValue={100}
              step={1}
              className="w-28"
              aria-label="Number of gates"
              value={genCount}
              onChange={onGenCountChange}
            />
            gates every
            <NumberField
              minValue={1}
              maxValue={720}
              // step must stay 1: RAC snaps to minValue + k·step, so
              // step 5 with min 1 would corrupt 15 → 16.
              step={1}
              className="w-28"
              aria-label="Gate interval (minutes)"
              value={genInterval}
              onChange={onGenIntervalChange}
            />
            min
            <Button variant="outline" size="sm" onPress={onGenerateSeries}>
              Generate from first gate
            </Button>
          </span>
        ) : null}
      </div>
    </>
  );
}
