/**
 * Small Base UI field wrappers shared by the comp/task dialogs so every
 * select and checkbox renders the same full component structure without
 * repeating the popup boilerplate at each call site.
 */
import { Checkbox } from "@base-ui/react/checkbox";
import { Field } from "@base-ui/react/field";
import { Select } from "@base-ui/react/select";
import { CaretDownIcon, CaretUpDownIcon, CaretUpIcon, CheckIcon } from "../components/icons";

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
      <Select.Trigger aria-label={ariaLabel} className="Select-trigger">
        <Select.Value className="Select-value" />
        <Select.Icon>
          <CaretUpDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="Select-positioner" sideOffset={4}>
          <Select.Popup className="Select-popup">
            <Select.ScrollUpArrow className="Select-scrollArrow">
              <CaretUpIcon />
            </Select.ScrollUpArrow>
            <Select.List className="Select-list">
              {options.map((o) => (
                <Select.Item key={o.value} value={o.value} className="Select-item">
                  <Select.ItemIndicator className="Select-itemIndicator">
                    <CheckIcon />
                  </Select.ItemIndicator>
                  <Select.ItemText className="Select-itemText">{o.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
            <Select.ScrollDownArrow className="Select-scrollArrow">
              <CaretDownIcon />
            </Select.ScrollDownArrow>
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
    <Field.Root className="Field">
      <Field.Label className="Checkbox-label">
        <Checkbox.Root checked={checked} onCheckedChange={(c) => onChange(c)} className="Checkbox">
          <Checkbox.Indicator className="Checkbox-indicator">
            <CheckIcon />
          </Checkbox.Indicator>
        </Checkbox.Root>{" "}
        {label}
      </Field.Label>
      {hint ? <Field.Description className="Field-description">{hint}</Field.Description> : null}
    </Field.Root>
  );
}
