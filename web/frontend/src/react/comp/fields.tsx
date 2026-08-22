/**
 * Small field wrappers shared by the comp/task dialogs so every select and
 * checkbox renders the same structure without repeating boilerplate at each
 * call site. Everything here is built on the RAC kit (src/react/rac/) — the
 * last Base UI pieces (the two selects) converted with the CompDetail page.
 */
import { useState } from "react";
import {
  Button as AriaButton,
  TextField as AriaTextField,
  useFilter,
} from "react-aria-components";
import { Checkbox as RacCheckbox } from "@/react/rac/checkbox";
import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import {
  Description,
  Input as RacInput,
  Label,
  NumberField,
  TextField,
} from "@/react/rac/field";
import { ChoiceList } from "@/react/rac/choice-list";
import {
  fromAltitudeInput,
  getUnitLabel,
  toAltitudeInput,
  useUnits,
} from "@/react/lib/units";

export { SimpleSelect } from "@/react/rac/select";

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
  valueM,
  onChange,
  description,
  hint,
}: {
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
          Altitude ({getUnitLabel("altitude", units)}){hint ? <> {hint}</> : null}
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
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <TextField
      label="Name"
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
}: {
  value: "hg" | "pg";
  onChange: (value: "hg" | "pg") => void;
  description?: React.ReactNode;
}) {
  return (
    <ChoiceList
      label="Wing"
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

/**
 * Ready-made class sets offered as one-click presets under the Pilot Classes
 * field, per wing. `open` (one ranking) leads both as the simple-club default;
 * the wing-specific variants follow:
 * - HG: `open, sport` (topless vs the kingposted Sport Class) and
 *   `open, sport, floater` (adding a lower-performance floater tier).
 * - PG: `open, sport` (open/CCC wings vs the ≤EN-C sport class) and
 *   `open, serial` (competition wings vs serial-certified gliders).
 */
const PILOT_CLASS_EXAMPLES: Record<"hg" | "pg", string[]> = {
  hg: ["open", "open, sport", "open, sport, floater"],
  pg: ["open", "open, sport", "open, serial"],
};

export function PilotClassesField({
  value,
  onChange,
  wing,
}: {
  value: string;
  onChange: (value: string) => void;
  wing: "hg" | "pg";
}) {
  const examples = PILOT_CLASS_EXAMPLES[wing];
  return (
    <AriaTextField value={value} onChange={onChange} className="group flex flex-col gap-2">
      <Label>Pilot Classes</Label>
      <RacInput placeholder={examples[1]} />
      <Description>
        Separately-scored divisions of the field. Comma-separated — or pick an example:
      </Description>
      <div className="flex flex-wrap gap-1.5">
        {examples.map((example) => (
          <AriaButton
            key={example}
            onPress={() => onChange(example)}
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

export function TestCompField({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <CheckboxField
      checked={checked}
      onChange={onChange}
      label="Hidden?"
      hint="Hidden from the public and pilots — only admins can see it."
    />
  );
}
