export interface FieldRowProps {
  label: string;
  defaultValue?: string;
  onChangeText: (text: string) => void;
  /** An email address: the email keyboard, and the phone's autofill. */
  email?: boolean;
  testID?: string;
}
