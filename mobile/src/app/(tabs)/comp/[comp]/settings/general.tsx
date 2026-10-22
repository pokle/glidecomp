/**
 * Settings → General: name, wing, timezone. The wing sets the official GAP
 * defaults; the timezone is how times are shown and which local day a track
 * belongs to (track quality), so both are scoring inputs on the server.
 */
import { WING_CHOICES } from '@glidecomp/client/comp-fields';
import type { CompDetailData } from '@glidecomp/client/types';
import { useState } from 'react';

import { updateComp } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { SettingsForm } from '@/components/SettingsForm';
import { isTimeZone } from '@/lib/settings-form';
import { Choices, Field, FormCard, FormHint } from '@/ui/form';
import { useFormSave } from '@/ui/use-form-save';

export default function GeneralSettings() {
  return <CompSettingsScreen title="General">{(comp) => <Form comp={comp} />}</CompSettingsScreen>;
}

function Form({ comp }: { comp: CompDetailData }) {
  const [base, setBase] = useState({ name: comp.name, category: (comp.category === 'pg' ? 'pg' : 'hg') as 'hg' | 'pg', timezone: comp.timezone ?? '' });
  const [v, setV] = useState(base);
  const { saving, note, setNote, run } = useFormSave();
  const dirty = v.name !== base.name || v.category !== base.category || v.timezone !== base.timezone;

  async function save() {
    if (!v.name.trim()) return setNote({ kind: 'error', text: 'A competition needs a name.' });
    const tz = v.timezone.trim();
    if (tz && !isTimeZone(tz)) return setNote({ kind: 'error', text: 'That isn’t a timezone name. Try one like Australia/Melbourne, or leave it empty for automatic.' });
    const ok = await run(() => updateComp(comp.comp_id, { name: v.name.trim(), category: v.category, timezone: tz || null }), 'Saved.');
    if (ok !== undefined) setBase(v);
  }

  return (
    <SettingsForm dirty={dirty} saving={saving} note={note} onSave={() => void save()} testID="settings-general-form">
      <FormCard>
        <Field label="Name" value={v.name} onChangeText={(name) => setV((x) => ({ ...x, name }))} testID="settings-name" />
        <Choices label="Wing" value={v.category} choices={WING_CHOICES} onChange={(category) => setV((x) => ({ ...x, category }))} testID="settings-wing" />
        <Field
          label="Timezone"
          value={v.timezone}
          onChangeText={(timezone) => setV((x) => ({ ...x, timezone }))}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="Automatic"
          testID="settings-timezone"
        />
        <FormHint>
          Comp-local zone for displaying times (start gates, replay clock, score narratives), e.g. Australia/Melbourne. Leave empty
          to derive it from the task location.
        </FormHint>
      </FormCard>
    </SettingsForm>
  );
}
