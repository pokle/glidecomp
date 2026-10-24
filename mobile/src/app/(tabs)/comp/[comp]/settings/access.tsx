/**
 * Settings → Access: who sees the competition, who registers, who records
 * flights for whom, and when submissions close — the website's switches in
 * its words.
 */
import type { CompDetailData } from '@glidecomp/client/types';
import { useState } from 'react';

import { updateComp } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { SettingsForm } from '@/components/SettingsForm';
import { isIsoDate } from '@/lib/task-form';
import { Field, FormCard, FormHint, Toggle } from '@/ui/form';
import { useFormSave } from '@/ui/use-form-save';

export default function AccessSettings() {
  return <CompSettingsScreen title="Access">{(comp) => <Form comp={comp} />}</CompSettingsScreen>;
}

function Form({ comp }: { comp: CompDetailData }) {
  const [base, setBase] = useState({
    test: comp.test,
    open_registration: comp.open_registration ?? true,
    open_igc_upload: comp.open_igc_upload,
    close_date: comp.close_date ?? '',
  });
  const [v, setV] = useState(base);
  const { saving, note, setNote, run } = useFormSave();
  const dirty = (Object.keys(v) as (keyof typeof v)[]).some((k) => v[k] !== base[k]);

  async function save() {
    const close = v.close_date.trim();
    if (close && !isIsoDate(close)) return setNote({ kind: 'error', text: 'Enter the close date as YYYY-MM-DD, or leave it empty.' });
    const ok = await run(
      () =>
        updateComp(comp.comp_id, {
          test: v.test,
          open_registration: v.open_registration,
          open_igc_upload: v.open_igc_upload,
          close_date: close || null,
        }),
      'Saved.',
    );
    if (ok !== undefined) setBase(v);
  }

  return (
    <SettingsForm dirty={dirty} saving={saving} note={note} onSave={() => void save()} testID="settings-access-form">
      <FormCard>
        <Toggle label="Hidden" hint="Hidden from the public and pilots — only admins can see it." value={v.test} onChange={(test) => setV((x) => ({ ...x, test }))} testID="settings-hidden" />
        <Toggle
          label="Let pilots register themselves by submitting a track"
          hint="Off, only admins add pilots. Pilots you registered can always submit."
          value={v.open_registration}
          onChange={(open_registration) => setV((x) => ({ ...x, open_registration }))}
          testID="settings-open-registration"
        />
        <Toggle
          label="Let registered pilots record flights and statuses for each other"
          hint="Covers uploading IGC tracks, recording manual flights, and setting pilot statuses (Absent / Did Not Fly). Admins can always do these regardless of this setting."
          value={v.open_igc_upload}
          onChange={(open_igc_upload) => setV((x) => ({ ...x, open_igc_upload }))}
          testID="settings-open-upload"
        />
      </FormCard>
      <FormCard>
        <Field
          label="Close date (YYYY-MM-DD)"
          value={v.close_date}
          onChangeText={(close_date) => setV((x) => ({ ...x, close_date }))}
          placeholder="Open-ended"
          keyboardType="numbers-and-punctuation"
          testID="settings-close-date"
        />
        <FormHint>After this date, track submissions are rejected. Leave empty for open-ended.</FormHint>
      </FormCard>
    </SettingsForm>
  );
}
