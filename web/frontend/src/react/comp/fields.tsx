/**
 * Small field wrappers shared by the comp/task dialogs so every select and
 * checkbox renders the same structure without repeating boilerplate at each
 * call site. The comp-form fields (name / wing / classes / hidden) are built
 * on the RAC kit (src/react/rac/) as part of the RAC exploration; the two
 * selects below are still shadcn/Base UI, used only by SettingsDialog.
 */
import {
  Button as AriaButton,
  TextField as AriaTextField,
} from "react-aria-components";
import { Checkbox as RacCheckbox } from "@/react/rac/checkbox";
import { Description, Input as RacInput, Label, TextField } from "@/react/rac/field";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/react/ui/combobox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/react/ui/select";

export interface SelectOption {
  value: string;
  label: string;
}

export function SimpleSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange((v as string) ?? "")}
      items={options}
      disabled={disabled}
    >
      <SelectTrigger aria-label={ariaLabel} className="min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Select-like combobox for long option lists (e.g. timezones): clicking or
 * typing in the input filters the options, so "aus" narrows hundreds of
 * entries down to the Australia/* ones. Same props as SimpleSelect.
 * Clearing the input without picking anything keeps the current value.
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
  const selected = options.find((o) => o.value === value) ?? null;
  return (
    <Combobox
      items={options}
      value={selected}
      onValueChange={(item) => {
        if (item) onChange(item.value);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxInput aria-label={ariaLabel} placeholder={placeholder} className="w-full" />
      <ComboboxContent>
        <ComboboxEmpty>No matches.</ComboboxEmpty>
        <ComboboxList>
          {(item: SelectOption) => (
            <ComboboxItem key={item.value} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
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
    <RadioGroup
      label="Wing"
      value={value}
      onChange={(v) => onChange(v as "hg" | "pg")}
      description={description}
    >
      <Radio value="hg">Hang Gliding</Radio>
      <Radio value="pg">Paragliding</Radio>
    </RadioGroup>
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
            className="inline-flex min-h-6 items-center rounded border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground transition-colors outline-none data-hovered:bg-accent data-hovered:text-accent-foreground data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
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
