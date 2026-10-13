export interface ChoiceRowProps<T extends string> {
  title: string;
  value: T;
  choices: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  testID?: string;
  /**
   * Android: the dropdown under the title rather than beside it. Material's
   * dropdown takes most of a row's width, which leaves a title longer than a
   * word or two ("Identify yourself by") a column of broken syllables. iOS
   * ignores it: its menu picker is only as wide as the value.
   */
  stacked?: boolean;
}
