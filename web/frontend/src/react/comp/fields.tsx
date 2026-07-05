/**
 * Small Base UI field wrappers shared by the comp/task dialogs so every
 * select and checkbox renders the same full component structure without
 * repeating the popup boilerplate at each call site.
 */
import { Checkbox } from "@base-ui/react/checkbox";
import { Field } from "@base-ui/react/field";
import { Select } from "@base-ui/react/select";

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
    <Select.Root
      value={value}
      onValueChange={(v) => onChange(v ?? "")}
      items={options}
      disabled={disabled}
    >
      <Select.Trigger aria-label={ariaLabel}>
        <Select.Value />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value}>
                <Select.ItemText>{o.label}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
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
    <Field.Root>
      <Field.Label>
        {/* Text glyph for both states: an unchecked Base UI checkbox is an
            empty (zero-size) span until styled, i.e. invisible and
            unclickable in this unstyled UI. */}
        <Checkbox.Root checked={checked} onCheckedChange={(c) => onChange(c)}>
          {checked ? "☑" : "☐"}
        </Checkbox.Root>{" "}
        {label}
      </Field.Label>
      {hint ? <Field.Description>{hint}</Field.Description> : null}
    </Field.Root>
  );
}
