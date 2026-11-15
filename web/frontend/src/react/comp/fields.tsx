/**
 * Small field wrappers shared by the comp/task dialogs so every select and
 * checkbox renders the same structure without repeating boilerplate at each
 * call site. Everything here is built on the RAC kit (src/react/rac/) — the
 * last Base UI pieces (the two selects) converted with the CompDetail page.
 */
import { PILOT_CLASS_EXAMPLES } from "./comp-fields";
import { parseCoords } from "./route-editor";
import { useId, useState } from "react";
import {
  Button as AriaButton,
  TextField as AriaTextField,
  useFilter,
} from "react-aria-components";
import { Checkbox as RacCheckbox } from "@/react/rac/checkbox";
import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import {
  Description,
  FieldError,
  Input as RacInput,
  Label,
  NumberField,
  TextField,
} from "@/react/rac/field";
import { ChoiceList } from "@/react/rac/choice-list";
import { useOptionalFormState } from "@/react/rac/form";
import { cn } from "@/react/lib/utils";
import {
  fromAltitudeInput,
  getUnitLabel,
  toAltitudeInput,
  useUnits,
} from "@/react/lib/units";

export { SimpleSelect } from "@/react/rac/select";

/** What is wrong with a latitude: missing, not a number, or out of range. */
export const LAT_HINT = "Enter a latitude between -90 and 90.";
/** What is wrong with a longitude: missing, not a number, or out of range. */
export const LON_HINT = "Enter a longitude between -180 and 180.";
/** Under both halves of a {@link CoordsField}: how to keep pasting a pair. */
export const COORDS_PASTE_HINT = 'Paste a "lat, lon" pair into either field to fill both.';

/** The `name` of a {@link CoordsField}'s longitude, beside `name` for its latitude. */
export function lonFieldName(name: string): string {
  return `${name}_lon`;
}

/** A plain decimal number, as `parseCoords` reads each half of a pair. */
const DECIMAL = /^[+-]?\d+(\.\d+)?$/;

function partProblem(text: string, limit: number, hint: string): string | null {
  const t = text.trim();
  if (!DECIMAL.test(t)) return hint;
  return Math.abs(Number(t)) <= limit ? null : hint;
}

/**
 * The two halves of a stored "lat, lon": split at the first comma, which is
 * how {@link joinCoords} writes them, so a half typed so far ("-36.5, ")
 * comes back where it was. A pair separated only by a space ("-36.5 147.9")
 * is read too. Anything else is all latitude.
 */
export function splitCoords(text: string): { lat: string; lon: string } {
  const t = String(text ?? "").trim();
  const comma = t.indexOf(",");
  if (comma >= 0) return { lat: t.slice(0, comma).trim(), lon: t.slice(comma + 1).trim() };
  const words = t.split(/\s+/);
  if (words.length === 2) return { lat: words[0], lon: words[1] };
  return { lat: t, lon: "" };
}

/** The stored "lat, lon" for two halves; blank when both are. */
export function joinCoords(lat: string, lon: string): string {
  const a = lat.trim();
  const b = lon.trim();
  return a === "" && b === "" ? "" : `${a}, ${b}`;
}

/**
 * The two numbers in a pasted or typed pair ("-36.55, 147.89", or with only
 * a space between them), as written — not reformatted, so a pasted
 * coordinate keeps every digit it came with. Null when it is not a pair.
 */
function pairIn(text: string): { lat: string; lon: string } | null {
  if (!parseCoords(text)) return null;
  const [lat, lon] = text.trim().split(/[,\s]+/);
  return { lat, lon };
}

/**
 * The problems with `text` as coordinates, keyed by the field each belongs
 * under — a {@link CoordsField} named `name` — for a kit form's `validate`,
 * which is what refuses a submit. Blank is fine unless the form needs them;
 * half a pair never is. {@link CoordsField} shows a malformed half live as
 * well.
 */
export function coordsProblems(
  name: string,
  text: string,
  required = false
): Record<string, string | null> {
  const { lat, lon } = splitCoords(text);
  if (lat === "" && lon === "") {
    return required ? { [name]: LAT_HINT, [lonFieldName(name)]: LON_HINT } : {};
  }
  return {
    [name]: partProblem(lat, 90, LAT_HINT),
    [lonFieldName(name)]: partProblem(lon, 180, LON_HINT),
  };
}

/**
 * A point's coordinates — the waypoint, the turnpoint, a new waypoint, the
 * altitude review and a manual flight's landing point — as two stacked
 * fields, Latitude and Longitude, holding one "lat, lon" value.
 *
 * Two fields because editing one half of "-36.550979, 147.890395" on a phone
 * meant placing a cursor inside a 22-character string with a thumb, without
 * disturbing the other half. One value because a pair is still what everyone
 * has to hand: pasting one from Google Maps into EITHER field fills both, and
 * a pair typed or dropped into one is split when the field is left (not as
 * it is typed: "-36.5, 147" would split before the 9 of 147.9 arrived, and
 * the 9 would land in the latitude). The keyboard stays the full one: the
 * only numeric pad a web page can ask an iPhone for has no minus key, and
 * every latitude in Australia is negative.
 *
 * The latitude is named `name`, so a form's error for the point lands on
 * it; the longitude is {@link lonFieldName}. A malformed half is flagged as
 * it is typed. A missing one is flagged as it is typed only where the field
 * is `required` and starts filled in (a waypoint's own page, where clearing
 * it is the mistake); elsewhere only when the form is submitted (its
 * `validate`, with {@link coordsProblems}), so a page does not open with an
 * error on it.
 */
export function CoordsField({
  label,
  name = "coords",
  value,
  onChange,
  placeholder = "-36.550979, 147.890395",
  required = false,
  className,
}: {
  /** A heading over the pair, for a point that is not simply "the" point. */
  label?: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  /** An example pair; each field shows its half. */
  placeholder?: string;
  required?: boolean;
  className?: string;
}) {
  // The halves as typed are this field's own: a stored "lat, lon" cannot
  // say where a half-typed latitude ends. A value that changes from outside
  // (a waypoint loaded, the map, a reload) replaces them.
  const [parts, setParts] = useState(() => splitCoords(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setParts(splitCoords(value));
  }
  const write = (next: { lat: string; lon: string }) => {
    const joined = joinCoords(next.lat, next.lon);
    setParts(next);
    setSeen(joined);
    onChange(joined);
  };

  const groupId = useId();
  const hintId = useId();
  const example = splitCoords(placeholder);
  const half = (which: "lat" | "lon") => {
    const limit = which === "lat" ? 90 : 180;
    const hint = which === "lat" ? LAT_HINT : LON_HINT;
    const pasteInto = (e: React.ClipboardEvent<HTMLInputElement>) => {
      const pair = pairIn(e.clipboardData.getData("text"));
      if (!pair) return;
      e.preventDefault();
      write(pair);
    };
    return (
      <AriaTextField
        className="group flex flex-col gap-2"
        name={which === "lat" ? name : lonFieldName(name)}
        value={parts[which]}
        onChange={(v) => write({ ...parts, [which]: v })}
        onBlur={() => {
          const pair = pairIn(parts[which]);
          if (pair) write(pair);
        }}
        validate={(v) =>
          v.trim() === "" ? (required ? hint : null) : partProblem(v, limit, hint)
        }
        aria-describedby={hintId}
      >
        <Label>{which === "lat" ? "Latitude" : "Longitude"}</Label>
        <RacInput
          placeholder={example[which]}
          spellCheck="false"
          autoCorrect="off"
          autoCapitalize="off"
          onPaste={pasteInto}
        />
        <FieldError />
      </AriaTextField>
    );
  };

  return (
    <div
      role="group"
      {...(label ? { "aria-labelledby": groupId } : { "aria-label": "Coordinates" })}
      className={cn("flex flex-col gap-4", className)}
    >
      {label ? (
        <span id={groupId} className="text-sm font-semibold">
          {label}
        </span>
      ) : null}
      {half("lat")}
      <div className="flex flex-col gap-2">
        {half("lon")}
        {/* A plain paragraph rather than the kit's Description: that is a
            RAC slot of ONE field, and this describes both. */}
        <p id={hintId} className="text-xs text-muted-foreground">
          {COORDS_PASTE_HINT}
        </p>
      </div>
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Select-like combobox for long option lists (e.g. timezones): clicking or
 * typing in the input filters the options, so "aus" narrows hundreds of
 * entries down to the Australia/* ones. Same props as SimpleSelect.
 * Clearing the input without picking anything keeps the current value.
 *
 * Both selectedKey and inputValue are controlled, so per RAC gotcha #12 the
 * resets are ours: onSelectionChange(null) (Esc / blur revert) restores the
 * current value's label instead of changing the value. While the input still
 * shows the selected label (at rest / just opened via menuTrigger="focus"),
 * every option is listed — filtering kicks in once the user edits.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const { contains } = useFilter({ sensitivity: "base" });
  const selected = options.find((o) => o.value === value) ?? null;
  const [input, setInput] = useState(selected?.label ?? "");
  const filtered =
    input === "" || input === selected?.label
      ? options
      : options.filter((o) => contains(o.label, input));
  return (
    <ComboBox
      aria-label={ariaLabel}
      placeholder={placeholder}
      isDisabled={disabled}
      menuTrigger="focus"
      selectedKey={value}
      inputValue={input}
      onInputChange={setInput}
      onSelectionChange={(key) => {
        if (key == null) {
          setInput(selected?.label ?? "");
          return;
        }
        const next = String(key);
        onChange(next);
        setInput(options.find((o) => o.value === next)?.label ?? next);
      }}
      items={filtered}
      allowsEmptyCollection
      renderEmptyState={() => (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No matches.</div>
      )}
      listClassName="max-h-80"
    >
      {(item: SelectOption) => (
        <ComboBoxItem id={item.value} textValue={item.label}>
          {item.label}
        </ComboBoxItem>
      )}
    </ComboBox>
  );
}

export function CheckboxField({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <RacCheckbox isSelected={checked} onChange={onChange} hint={hint}>
      {label}
    </RacCheckbox>
  );
}

/**
 * Altitude input in the reader's own unit.
 *
 * Altitudes are stored, exported and scored in metres, but every place the app
 * PRINTS one (the turnpoint list, the waypoints table) honours the reader's
 * unit preference — so an input that hard-labelled itself "(m)" made the two
 * disagree in front of them: a value typed here reappeared multiplied in the
 * list beside it (issue #662). The label names the unit it is showing, and the
 * conversion happens at this edge only — `valueM` and `onChange` are metres.
 *
 * A blank altitude ("unknown", which is what "Fill altitudes from map" looks
 * for) is NaN, the same spelling RAC's NumberField uses for an empty field.
 */
export function AltitudeField({
  label = "Altitude",
  valueM,
  onChange,
  description,
  hint,
}: {
  /** What the number is; the unit is appended: "Upper limit (ft)". */
  label?: string;
  /** Metres, or NaN when blank. */
  valueM: number;
  /** Metres, or NaN when the field is cleared. */
  onChange: (metres: number) => void;
  description?: string;
  hint?: React.ReactNode;
}) {
  const units = useUnits();
  return (
    <NumberField
      label={
        <>
          {label} ({getUnitLabel("altitude", units)}){hint ? <> {hint}</> : null}
        </>
      }
      description={description}
      value={toAltitudeInput(valueM, units)}
      onChange={(v) => onChange(fromAltitudeInput(v, units))}
      // Step stays 1 (RAC snaps to minValue + k·step), and thousands group so
      // a cloudbase in feet reads "10,000".
      step={1}
      formatOptions={{ useGrouping: true, maximumFractionDigits: 0 }}
    />
  );
}

/*
 * Fields shared by the create-competition and competition-settings dialogs.
 * Keeping the markup in one place stops the two forms drifting apart (labels,
 * placeholders, comma-separated hints, validation shape) as either evolves.
 */

export function NameField({
  value,
  onChange,
  placeholder,
  autoFocus,
  name = "name",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** The field's name in a kit form (rac/form.tsx). */
  name?: string;
}) {
  return (
    <TextField
      label="Name"
      name={name}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      isRequired
      maxLength={128}
      autoFocus={autoFocus}
    />
  );
}

export function CategoryField({
  value,
  onChange,
  description,
  name = "category",
}: {
  value: "hg" | "pg";
  onChange: (value: "hg" | "pg") => void;
  description?: React.ReactNode;
  /** The field's name in a kit form (rac/form.tsx). */
  name?: string;
}) {
  return (
    <ChoiceList
      label="Wing"
      name={name}
      value={value}
      onChange={(v) => onChange(v as "hg" | "pg")}
      description={description}
      options={[
        { value: "hg", label: "Hang Gliding" },
        { value: "pg", label: "Paragliding" },
      ]}
    />
  );
}

// The presets live in comp-fields.ts.

export function PilotClassesField({
  value,
  onChange,
  wing,
  name = "pilot_classes",
}: {
  value: string;
  onChange: (value: string) => void;
  wing: "hg" | "pg";
  /** The field's name in a kit form (rac/form.tsx). */
  name?: string;
}) {
  const examples = PILOT_CLASS_EXAMPLES[wing];
  // An example chip sets the value without an input event of its own, which
  // is what clears a field's error in a kit form — so it clears it itself.
  const form = useOptionalFormState();
  return (
    <AriaTextField
      value={value}
      onChange={onChange}
      name={name}
      className="group flex flex-col gap-2"
    >
      <Label>Pilot classes</Label>
      <RacInput placeholder={examples[1]} />
      <FieldError />
      <Description>
        Separately-scored divisions of the field. Comma-separated — or pick an example:
      </Description>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((example) => (
          <AriaButton
            key={example}
            onPress={() => {
              onChange(example);
              form?.clearFieldError(name);
            }}
            aria-label={`Use example: ${example}`}
            // 44px on a phone (issue #641). These are chips meant to be
            // tapped, and the row can simply grow — it is the last thing on
            // the field, with nothing below it to push around.
            className="inline-flex min-h-6 items-center rounded border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground transition-colors outline-none pointer-coarse:min-h-11 pointer-coarse:px-3 data-hovered:bg-accent data-hovered:text-accent-foreground data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
          >
            {example}
          </AriaButton>
        ))}
      </div>
    </AriaTextField>
  );
}
