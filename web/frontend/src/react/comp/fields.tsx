/**
 * Small field wrappers shared by the comp/task dialogs so every select and
 * checkbox renders the same structure without repeating boilerplate at each
 * call site. Built on the shadcn/ui components (Base UI underneath).
 */
import { useId } from "react";
import { Checkbox } from "@/react/ui/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/react/ui/combobox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { RadioGroup, RadioGroupItem } from "@/react/ui/radio-group";
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
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <FieldLabel htmlFor={id} className="font-normal">
        {label}
      </FieldLabel>
      {hint ? <FieldDescription className="basis-full">{hint}</FieldDescription> : null}
    </Field>
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
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Name</FieldLabel>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required
        maxLength={128}
        autoFocus={autoFocus}
      />
    </Field>
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
  const hgId = useId();
  const pgId = useId();
  return (
    <FieldSet>
      <FieldLegend variant="label">Wing</FieldLegend>
      <RadioGroup value={value} onValueChange={(v) => onChange(v as "hg" | "pg")}>
        <Field orientation="horizontal">
          <RadioGroupItem value="hg" id={hgId} />
          <FieldLabel htmlFor={hgId} className="font-normal">
            Hang Gliding
          </FieldLabel>
        </Field>
        <Field orientation="horizontal">
          <RadioGroupItem value="pg" id={pgId} />
          <FieldLabel htmlFor={pgId} className="font-normal">
            Paragliding
          </FieldLabel>
        </Field>
      </RadioGroup>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </FieldSet>
  );
}

export function PilotClassesField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Pilot Classes</FieldLabel>
      <Input
        id={id}
        placeholder="open, sport, floater"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <FieldDescription>Comma-separated class names</FieldDescription>
    </Field>
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
      label="Test competition (only visible to admins)"
    />
  );
}
