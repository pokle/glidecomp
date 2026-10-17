/**
 * Me → Track uploads: the upload queue's visible home (IA §16). Every track
 * still on the phone, saying plainly that it has not been submitted, and the
 * week's receipts. "Send now" tries everything waiting at once rather than
 * waiting for the next timed try.
 */
import { router, Stack } from 'expo-router';

import { useIdentity } from '@/auth/session';
import { ago } from '@/lib/ago';
import { sendBlock, statusWords, submissionTitle } from '@/lib/submission';
import { sendWaiting, useSubmissions } from '@/submit/queue';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';

export default function Uploads() {
  const { items, sending } = useSubmissions();
  const identity = useIdentity();
  const accountId = identity.kind === 'signed-in' ? identity.user.id : null;
  const onPhone = items.filter((s) => s.status !== 'sent');
  const sent = items.filter((s) => s.status === 'sent');
  const row = (s: (typeof items)[number]) => {
    const words = statusWords(s, { sending: sending.has(s.id), block: sendBlock(s, accountId) });
    return (
      <Row
        key={s.id}
        testID={`upload-${s.id}`}
        title={submissionTitle(s)}
        value={words.status}
        detail={`${words.detail} · ${ago(s.sentAt ?? s.queuedAt)}`}
        onPress={() => router.push(`/me/upload/${s.id}` as never)}
      />
    );
  };
  return (
    <>
      <Stack.Screen options={{ title: 'Track uploads', headerLargeTitle: false }} />
      <GroupedList testID="uploads">
        {onPhone.length > 0 ? (
          <Group title="On this phone" testID="uploads-waiting">
            {onPhone.map(row)}
            {onPhone.some((s) => s.status === 'waiting') ? (
              <ActionRow testID="send-now" title="Send now" onPress={() => void sendWaiting({ force: true })} />
            ) : null}
          </Group>
        ) : null}
        {sent.length > 0 ? (
          <Group title="Submitted" testID="uploads-sent">
            {sent.map(row)}
          </Group>
        ) : null}
        {items.length === 0 ? (
          <Group>
            <Note>No tracks sent from this phone this week.</Note>
          </Group>
        ) : null}
        <Group>
          <Note>
            A track is saved on this phone before it is sent, and stays here until GlideComp has accepted it.
            Receipts are kept for a week.
          </Note>
        </Group>
      </GroupedList>
    </>
  );
}
