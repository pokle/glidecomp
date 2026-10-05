import { Redirect } from 'expo-router';

// A cold start lands on Comps, the launch tab (IA §2).
export default function Index() {
  return <Redirect href="/comps" />;
}
