export interface ChoiceRowProps<T extends string> {
  title: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testID?: string;
}
