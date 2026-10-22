/**
 * Send to instrument (IA §7, "the native app's best single feature"): a task
 * or a waypoint set as a QR code for a briefing screen, or as a file through
 * the share sheet — AirDrop, Files, or straight into XCTrack, Flyskyhy or
 * SeeYou Navigator. The files are written on the phone from the engine's
 * exporters, so this works on a hill with no signal once the task has been
 * read.
 *
 * The groups are inline, as Android's list requires (mobile/CLAUDE.md,
 * "Lists").
 */
import {
  formatsFor,
  instrumentFile,
  instrumentQr,
  type InstrumentSource,
} from '@glidecomp/client/instrument';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert } from 'react-native';

import { shareFile } from '@/lib/send-file';
import { ChoiceRow } from '@/ui/choice-row';
import { ActionRow, GroupedList, Group, Note, Row } from '@/ui/grouped-list';

type Label = 'code' | 'name';

export function SendToInstrument({
  source,
  qrParams,
  noun,
}: {
  source: InstrumentSource;
  /** What the full-screen QR route needs to find this source again. */
  qrParams: Record<string, string>;
  /** "turnpoint" or "waypoint", for the counts. */
  noun: string;
}) {
  const [label, setLabel] = useState<Label>('code');
  const swap = label === 'name';
  const qr = instrumentQr(source, { swap });
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  const send = async (formatId: string) => {
    const file = instrumentFile(source, formatId, { swap });
    if (!file) return;
    try {
      await shareFile(file, source.name);
    } catch {
      Alert.alert('Couldn’t share the file', 'Try again, or choose another format.');
    }
  };

  return (
    <GroupedList testID="send-to-instrument">
      <Group>
        <ChoiceRow
          testID="device-label"
          stacked
          title="Label on the device"
          value={label}
          choices={[
            { value: 'code', label: 'Code' },
            { value: 'name', label: 'Full name' },
          ]}
          onChange={setLabel}
        />
      </Group>

      <Group title="QR code" testID="send-qr">
        {qr.count === 0 ? (
          <Note>{`No ${noun}s to put in a code yet.`}</Note>
        ) : qr.value ? (
          <Row
            testID="show-qr"
            title="Show QR code"
            detail={`Scan with XCTrack, Flyskyhy or any app that reads XCTSK task QRs · ${plural(qr.count)}`}
            onPress={() =>
              router.push({ pathname: '/qr', params: { ...qrParams, ...(swap ? { swap: '1' } : {}) } } as never)
            }
          />
        ) : (
          <Note>{`Too many ${noun}s (${qr.count}) to fit in a single QR code — send a file instead.`}</Note>
        )}
      </Group>

      <Group title="Files" testID="send-files">
        {formatsFor(source).map((f) => (
          <ActionRow key={f.id} testID={`send-${f.id}`} title={f.label} onPress={() => void send(f.id)} />
        ))}
      </Group>
    </GroupedList>
  );
}
