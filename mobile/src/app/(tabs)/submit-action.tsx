import { Redirect } from 'expo-router';

// The Submit tab is an action (see the tabs layout); this route only exists so
// the tab has a name. Anything that navigates here directly gets the sheet.
export default function SubmitAction() {
  return <Redirect href="/submit" />;
}
