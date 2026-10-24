/**
 * Settings → Organisers: who runs the competition, by email. At least one;
 * an address with no account yet becomes an organiser when they sign up.
 */
import type { CompDetailData } from '@glidecomp/client/types';
import { useState } from 'react';

import { updateComp } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { SettingsForm } from '@/components/SettingsForm';
import { parseEmails } from '@/lib/settings-form';
import { Field, FormCard, FormHint } from '@/ui/form';
import { useFormSave } from '@/ui/use-form-save';

export default function OrganiserSettings() {
  return <CompSettingsScreen title="Organisers">{(comp) => <Form comp={comp} />}</CompSettingsScreen>;
}

function Form({ comp }: { comp: CompDetailData }) {
  const [base, setBase] = useState(comp.admins.map((a) => a.email).join(', '));
  const [text, setText] = useState(base);
  const { saving, note, setNote, run } = useFormSave();
  const dirty = parseEmails(text).emails.join() !== parseEmails(base).emails.join();

  async function save() {
    const { emails, bad } = parseEmails(text);
    if (bad) return setNote({ kind: 'error', text: `“${bad}” isn’t an email address.` });
    if (emails.length === 0) return setNote({ kind: 'error', text: 'A competition needs at least one organiser.' });
    const ok = await run(() => updateComp(comp.comp_id, { admin_emails: emails }), 'Saved.');
    if (ok !== undefined) setBase(emails.join(', '));
  }

  return (
    <SettingsForm dirty={dirty} saving={saving} note={note} onSave={() => void save()} testID="settings-organisers-form">
      <FormCard>
        <Field
          label="Admin emails"
          value={text}
          onChangeText={setText}
          multiline
          autoCapitalize="none"
          keyboardType="email-address"
          placeholder="admin1@example.com, admin2@example.com"
          style={{ minHeight: 88, paddingTop: 10, textAlignVertical: 'top' }}
          testID="settings-admins"
        />
        <FormHint>Comma-separated. At least one required.</FormHint>
      </FormCard>
    </SettingsForm>
  );
}
