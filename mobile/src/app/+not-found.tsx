/**
 * A link the app has no screen for. Universal links (stage 9) send any
 * /comp/… URL here when its shape is unknown — an old URL, a mistyped one —
 * and the repair offers what its words name now.
 */
import { Stack } from 'expo-router';
import { View } from 'react-native';

import { LinkRepair } from '@/components/LinkRepair';

export default function NotFoundScreen() {
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Not found', headerShown: true }} />
      <LinkRepair message="This link doesn’t open anything any more." />
    </View>
  );
}
