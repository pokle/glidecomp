/**
 * Upload a waypoint file (IA §10, stage 7): any format the website reads —
 * OziExplorer (feet), SeeYou, CompeGPS, GPX, KML, CSV — through the engine's
 * own parser, codes cleaned the same way. It REPLACES the competition's
 * waypoint set; tasks already built keep their own copy of their
 * turnpoints, so nothing flown changes.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { cleanWaypointCodes, describeCodeChanges, parseWaypointFile, type WaypointFileRecord } from '@glidecomp/engine';
import { File } from 'expo-file-system';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { saveWaypoints } from '@/api/organiser';
import { useCompWaypoints } from '@/api/queries';
import { FormCard, FormHint, FormMessage, FormScreen, PrimaryButton, TextButton } from '@/ui/form';
import { confirmDestructive, useFormSave } from '@/ui/use-form-save';

export default function UploadWaypoints() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const compId = idFromSegment(segment);
  const current = useCompWaypoints(compId).data ?? [];
  const [file, setFile] = useState<{ name: string; format: string; waypoints: WaypointFileRecord[]; codeNote: string | null } | null>(null);
  const { saving, note, setNote, run } = useFormSave();

  async function pick() {
    setNote(null);
    try {
      const picked = await File.pickFileAsync();
      if (picked.canceled) return;
      const f = picked.result;
      const { waypoints, format } = parseWaypointFile(await f.text(), f.name);
      if (waypoints.length === 0) return setNote({ kind: 'error', text: `${f.name} has no waypoints this app can read.` });
      const { waypoints: cleaned, changes } = cleanWaypointCodes(waypoints);
      setFile({ name: f.name, format, waypoints: cleaned, codeNote: describeCodeChanges(changes) });
    } catch {
      setNote({ kind: 'error', text: 'Couldn’t read that file as waypoints.' });
    }
  }

  async function save() {
    if (!file) return;
    if (current.length > 0 && !(await confirmDestructive('Replace the waypoints?', `The ${current.length} waypoints now on the competition are replaced by the ${file.waypoints.length} in ${file.name}.`, 'Replace')))
      return;
    const ok = await run(async () => {
      await saveWaypoints(compId, file.waypoints);
      return true;
    });
    if (ok) router.back();
  }

  return (
    <FormScreen testID="upload-waypoints">
      <Stack.Screen options={{ title: 'Upload waypoints', headerLargeTitle: false }} />
      <FormCard>
        <FormHint>OziExplorer, SeeYou, CompeGPS, FS, GPX, KML or CSV. The file replaces the competition’s waypoints; tasks already set keep their own turnpoints.</FormHint>
        <TextButton title={file ? 'Choose another file' : 'Choose a file'} onPress={() => void pick()} testID="upload-waypoints-pick" />
      </FormCard>
      {file ? (
        <FormCard title={file.name}>
          <FormHint>{`${file.waypoints.length} waypoints, read as ${file.format}.`}</FormHint>
          {file.codeNote ? <FormHint>{file.codeNote}</FormHint> : null}
        </FormCard>
      ) : null}
      {note ? <FormMessage kind={note.kind}>{note.text}</FormMessage> : null}
      {file ? <PrimaryButton title="Replace the waypoints" pendingLabel="Saving the waypoints" pending={saving} onPress={() => void save()} testID="upload-waypoints-save" /> : null}
    </FormScreen>
  );
}
