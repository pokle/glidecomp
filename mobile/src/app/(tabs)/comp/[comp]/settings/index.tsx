/**
 * Competition settings (IA §13, stage 7): straight Settings, as the website
 * converged on — a row per group, each showing its value, and the danger
 * zone. Every save is audited; the ones that are scoring inputs (wing,
 * format, GAP parameters, classes, timezone) also mark the scores stale.
 */
import { scoringSummary, accessSummary } from '@glidecomp/client/scoring-settings';
import { categoryLabel } from '@glidecomp/client/format';
import { router, useLocalSearchParams } from 'expo-router';

import { deleteComp, writeErrorText } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { ActionRow, GroupedList, Group, Row } from '@/ui/grouped-list';
import { confirmDestructive } from '@/ui/use-form-save';
import { Alert } from 'react-native';

export default function CompSettings() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const go = (group: string) => () => router.push(`/comp/${segment}/settings/${group}` as never);
  return (
    <CompSettingsScreen title="Settings">
      {(comp) => (
        <GroupedList testID="comp-settings">
          <Group>
            <Row testID="settings-general" title="General" value={comp.name} detail={`${categoryLabel(comp.category)} · ${comp.timezone ?? 'Timezone automatic'}`} onPress={go('general')} />
            <Row testID="settings-access" title="Access" value={accessSummary(comp)} onPress={go('access')} />
            <Row testID="settings-classes" title="Pilot classes" value={comp.pilot_classes.join(', ')} onPress={go('classes')} />
            <Row testID="settings-scoring" title="Scoring" value={scoringSummary(comp)} onPress={go('scoring')} />
            <Row
              testID="settings-organisers"
              title="Organisers"
              value={String(comp.admins.length)}
              detail={comp.admins.map((a) => a.name || a.email).join(', ')}
              onPress={go('organisers')}
            />
          </Group>
          <Group title="Danger zone">
            <ActionRow
              destructive
              testID="settings-delete"
              title="Delete competition"
              onPress={async () => {
                const ok = await confirmDestructive(
                  'Delete this competition?',
                  'All its tasks and tracks will be deleted. This cannot be undone.',
                  'Delete',
                );
                if (!ok) return;
                try {
                  await deleteComp(comp.comp_id);
                  router.dismissTo('/comp' as never);
                } catch (err) {
                  Alert.alert('Couldn’t delete the competition', writeErrorText(err));
                }
              }}
            />
          </Group>
        </GroupedList>
      )}
    </CompSettingsScreen>
  );
}
