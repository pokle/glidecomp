import { router } from 'expo-router';
import { NativeTabs } from 'expo-router/native-tabs';

export default function TabsLayout() {
  return (
    // Material shows only the selected tab's label by default; every tab is
    // labelled here, so no destination is a bare icon to guess at.
    <NativeTabs labelVisibilityMode="labeled">
      <NativeTabs.Trigger name="comp">
        <NativeTabs.Trigger.Label>Comps</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="trophy" md="emoji_events" />
      </NativeTabs.Trigger>

      {/* An action, not a destination: the tab never selects, it presents the
          submit sheet over the current screen. `disabled` stops the native
          selection while still emitting tabPress. */}
      <NativeTabs.Trigger
        name="submit-action"
        disabled
        listeners={{ tabPress: () => router.push('/submit') }}>
        <NativeTabs.Trigger.Label>Submit</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="square.and.arrow.up" md="upload" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="flights">
        <NativeTabs.Trigger.Label>My flights</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="point.topleft.down.to.point.bottomright.curvepath" md="route" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="me">
        <NativeTabs.Trigger.Label>Me</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="person.crop.circle" md="account_circle" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
