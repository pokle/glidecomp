/**
 * One track from the upload queue: its receipt once accepted, the refusal and
 * a way to fix it, or where it is while it waits.
 */
import { pilotPath } from '@glidecomp/client/slug';
import { router, Stack, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useIdentity } from '@/auth/session';
import { sendBlock, statusWords, submissionTitle } from '@/lib/submission';
import { useUnits } from '@/settings/units';
import { remove, useSubmission } from '@/submit/queue';
import { failureGroup, receiptGroups } from '@/submit/receipt';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export default function Upload() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { sub, sending } = useSubmission(id);
  const identity = useIdentity();
  const units = useUnits();
  // Gone while on screen — withdrawn, or replaced by "Fix and send again",
  // which queues a new track: back to the list, where the new one is.
  // This screen's own navigation, not `router`: "Fix and send again" has the
  // submit sheet on top, and `router.back()` would close the sheet instead.
  const navigation = useNavigation();
  const seen = useRef(false);
  useEffect(() => {
    if (sub) seen.current = true;
    else if (seen.current && navigation.canGoBack()) navigation.goBack();
  }, [sub, navigation]);
  if (!sub) {
    return (
      <>
        <Stack.Screen options={{ title: 'Track upload', headerLargeTitle: false }} />
        <GroupedList>
          <Group>
            <Note>This track is no longer on this phone.</Note>
          </Group>
        </GroupedList>
      </>
    );
  }
  const block = sendBlock(sub, identity.kind === 'signed-in' ? identity.user.id : null);
  const words = statusWords(sub, { sending, block });

  const confirmWithdraw = () =>
    Alert.alert(
      'Withdraw this track?',
      'It hasn’t been submitted, and it will be deleted from this phone. Your IGC file itself is not affected.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: () => remove(sub.id),
        },
      ],
    );

  return (
    <>
      <Stack.Screen options={{ title: submissionTitle(sub), headerLargeTitle: false }} />
      <GroupedList testID="upload-detail">
        {sub.status === 'sent' ? receiptGroups(sub, units) : null}
        {sub.status === 'sent' && sub.accepted?.comp_pilot_id ? (
          <Group>
            <Row
              title="View provisional score card"
              onPress={() =>
                router.push(
                  pilotPath(
                    sub.compId,
                    sub.compName,
                    sub.taskId,
                    sub.taskName,
                    sub.accepted!.comp_pilot_id,
                    sub.accepted?.pilot_name ?? null,
                  ) as never,
                )
              }
            />
          </Group>
        ) : null}

        {sub.status === 'refused' && sub.failure
          ? failureGroup(
              sub.failure,
              <Row
                testID="fix-and-send"
                title="Fix and send again"
                onPress={() => router.push({ pathname: '/submit', params: { retry: sub.id } } as never)}
              />,
            )
          : null}

        {sub.status === 'waiting' ? (
          <Group title={words.status} testID="upload-waiting">
            <Note>{words.detail}</Note>
          </Group>
        ) : null}

        <Group title="The submission">
          <Row title="For" value={sub.forLabel} />
          <Row title="File" value={sub.fileName} />
          {sub.filePilotName ? <Row title="Named in the file" value={sub.filePilotName} /> : null}
        </Group>

        {sub.status !== 'sent' ? (
          <Group>
            <ActionRow testID="withdraw" title="Withdraw this track" destructive onPress={confirmWithdraw} />
          </Group>
        ) : null}
      </GroupedList>
    </>
  );
}
