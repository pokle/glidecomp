/**
 * What a submission came to, as groups of the native list: the receipt for a
 * stored track, the refusal with whoever can fix it, or the plain fact that
 * the track is still on the phone. Shared by the submit sheet and Me → Track
 * uploads, so a pilot reads the same words in both.
 *
 * These are plain functions that RETURN groups, called inline — never
 * components — because Android's list only recognises a section that is its
 * direct child (mobile/CLAUDE.md, "Lists").
 */
import {
  formatClockInZone,
  formatDuration,
  formatRetryAfter,
  formatTrackAltitude,
  formatTrackDistance,
  type SubmitError,
} from '@glidecomp/client/submit';
import type { UnitPreferences } from '@glidecomp/engine';
import * as Linking from 'expo-linking';
import type { ReactNode } from 'react';

import type { Submission } from '@/lib/submission';
import { Group, Note, Row } from '@/ui/grouped-list';

/**
 * The receipt for a stored track. The scores are a background recompute away
 * and depend on everyone else's tracks, so this is the moment — and the only
 * cheap one — at which a pilot can notice they sent yesterday's file. Hence
 * the times and the distance rather than a bare tick.
 */
export function receiptGroups(sub: Submission, units: UnitPreferences) {
  const accepted = sub.accepted ?? { comp_pilot_id: '' };
  const s = accepted.flight_summary ?? null;
  const findings = accepted.track_quality?.findings ?? [];
  const pilot = accepted.pilot_name ?? null;
  const zone = sub.timezone;
  const groups = [
    <Group key="accepted" title={`${accepted.replaced ? 'Track replaced' : 'Track submitted'}${pilot ? ` for ${pilot}` : ''}`} testID="receipt">
      <Note>{`${sub.taskName ? `${sub.taskName}, ` : ''}${sub.compName ?? 'your competition'}. Check the flight below is the one you meant to send.`}</Note>
    </Group>,
  ];
  if (s) {
    groups.push(
      <Group key="flight" title="The flight">
        <Row title="Date" value={s.flight_date ?? 'Not stated in the file'} />
        <Row title="Take off" value={formatClockInZone(s.takeoff_at, zone)} />
        <Row title="Landing" value={formatClockInZone(s.landing_at, zone)} />
        <Row title="Airborne" value={formatDuration(s.duration_seconds)} />
        <Row title="Track length" value={formatTrackDistance(s.track_length_m, units)} />
        <Row title="Highest point" value={formatTrackAltitude(s.max_altitude_m, units)} />
        {s.header_glider_type ? <Row title="Glider" value={s.header_glider_type} /> : null}
        {s.header_pilot_name ? <Row title="Named in the file" value={s.header_pilot_name} /> : null}
      </Group>,
    );
  }
  if (findings.length > 0) {
    groups.push(
      <Group
        key="findings"
        testID="receipt-findings"
        title={
          accepted.track_quality?.hard_failed
            ? 'This track will not be scored as it stands'
            : 'This track needs checking'
        }>
        {findings.map((f) => (
          <Note key={f.id}>{f.detail}</Note>
        ))}
        <Note>It is saved either way. Submit the right file and it replaces this one.</Note>
      </Group>,
    );
  }
  const notified = accepted.notified;
  const emailLine = notified?.emailed
    ? `We emailed ${notified.masked_to} to tell them${accepted.replaced ? ' their track was replaced.' : ' a track was submitted for them.'}`
    : // "No address" only. The other reason — the address IS the submitter's
      // own — needs no line: telling somebody we did not email them about a
      // thing they just did would be noise.
      notified?.reason === 'no_registered_email'
      ? 'We could not email a confirmation — no address is registered for this pilot. Tell the organiser if this was not you.'
      : null;
  groups.push(
    <Group key="after">
      {emailLine ? <Note>{emailLine}</Note> : null}
      <Note>Scores are provisional — they move as other pilots submit.</Note>
    </Group>,
  );
  return groups;
}

/**
 * A refusal the pilot can act on: what went wrong, and who can fix it. Where
 * the pilot cannot — a duplicated roster row, a comp that has closed — the
 * organisers are named, and each opens a message to them.
 */
export function failureGroup(failure: SubmitError, extra?: ReactNode) {
  const organisers = failure.organisers ?? [];
  return (
    <Group key="failure" title="We could not accept that track" testID="submit-failure">
      <Note>{failure.error}</Note>
      {failure.retry_after_seconds ? <Note>{`Try again ${formatRetryAfter(failure.retry_after_seconds)}.`}</Note> : null}
      {organisers.map((o) => (
        <Row
          key={o.email}
          title={o.name}
          detail={o.email}
          value="Organiser"
          onPress={() => void Linking.openURL(`mailto:${o.email}`)}
        />
      ))}
      {extra ?? null}
    </Group>
  );
}
