/**
 * Import a roster CSV (stage 7): the website's format and rules, from
 * @glidecomp/client/roster-csv — headers in any order, CIVL ID, other IDs
 * then email to match an existing pilot, never a name alone. The file
 * REPLACES the roster: pilots it leaves out are removed, and the screen says
 * how many before anything is saved.
 */
import {
  classifyImportRows,
  importedRows,
  parseImportedCsv,
  validateRows,
  type ImportClassifiedRow,
} from '@glidecomp/client/roster-csv';
import { idFromSegment } from '@glidecomp/client/slug';
import { File } from 'expo-file-system';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { bulkSaveRoster } from '@/api/organiser';
import { useComp, useRosterDetail } from '@/api/queries';
import { FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, TextButton } from '@/ui/form';
import { confirmDestructive, useFormSave } from '@/ui/use-form-save';

export default function ImportRosterScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const comp = useComp(compId).data;
  const current = useRosterDetail(compId).data ?? [];
  const [file, setFile] = useState<{ name: string; classified: ImportClassifiedRow[]; errors: string[] } | null>(null);
  const { saving, note, setNote, run } = useFormSave();

  async function pick() {
    setNote(null);
    try {
      const picked = await File.pickFileAsync();
      if (picked.canceled) return;
      const f = picked.result;
      const text = await f.text();
      const parsed = parseImportedCsv(text, comp?.pilot_classes ?? ['open']);
      setFile({ name: f.name, classified: classifyImportRows(parsed.rows, current), errors: parsed.errors });
    } catch {
      setNote({ kind: 'error', text: 'Couldn’t read that file. Choose a CSV or TSV with a header row.' });
    }
  }

  const rows = file ? importedRows(file.classified) : [];
  const matched = file?.classified.filter((c) => c.action === 'match').length ?? 0;
  const nameOnly = file?.classified.filter((c) => c.action === 'name').length ?? 0;
  const keptIds = new Set(rows.map((r) => r.comp_pilot_id).filter(Boolean));
  const removed = current.filter((p) => !keptIds.has(p.comp_pilot_id)).length;

  async function replace() {
    if (!comp || !file) return;
    const { payload, errors } = validateRows(rows, comp.pilot_classes);
    if (errors.length > 0) return setNote({ kind: 'error', text: errors[0] });
    if (removed > 0 && !(await confirmDestructive('Replace the roster?', `${removed} pilots who aren’t in the file will be removed.`, 'Replace')))
      return;
    const ok = await run(async () => {
      await bulkSaveRoster(comp.comp_id, payload);
      return true;
    });
    if (ok) router.back();
  }

  return (
    <FormScreen testID="roster-import-screen">
      <Stack.Screen options={{ title: 'Import CSV', headerLargeTitle: false }} />
      <FormCard>
        <FormHint>
          A header row, then one pilot a line. Only “name” is required; class, email, civl_id, glider, team and the other IDs are read when
          present. Comma, tab or semicolon separated, as a spreadsheet saves it.
        </FormHint>
        <TextButton title={file ? 'Choose another file' : 'Choose a file'} onPress={() => void pick()} testID="roster-import-pick" />
      </FormCard>
      {file ? (
        <FormCard title={file.name}>
          <FormHint>{`${rows.length} pilots: ${matched} match existing pilots, ${rows.length - matched} new.`}</FormHint>
          {nameOnly > 0 ? (
            <FormHint>{`${nameOnly} share a name with a pilot already on the roster but nothing else, so they come in as new entries — names never link two entries.`}</FormHint>
          ) : null}
          {removed > 0 ? <FormHint>{`${removed} pilots on the roster aren’t in the file and will be removed.`}</FormHint> : null}
          {file.errors.slice(0, 5).map((e) => (
            <FormMessage key={e} kind="error">
              {e}
            </FormMessage>
          ))}
        </FormCard>
      ) : null}
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      {file && rows.length > 0 ? (
        <PrimaryButton title="Replace the roster" pendingLabel="Saving the roster" pending={saving} onPress={() => void replace()} testID="roster-import-save" />
      ) : null}
    </FormScreen>
  );
}
