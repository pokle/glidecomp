/**
 * Organiser's notes (stage 7; migration 0037): the organiser's standing word
 * to the whole competition — "Briefing 9:30 at the launch shelter". Shown on
 * the comp view here and on the website's comp page. Not a scoring input:
 * the server audit-logs an edit with an excerpt and never marks scores
 * stale.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import type { CompDetailData } from '@glidecomp/client/types';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { updateComp } from '@/api/organiser';
import { useComp } from '@/api/queries';
import { NotesForm } from '@/components/NotesForm';
import { QueryGate, StaleBanner } from '@/ui/QueryStates';

export default function CompNotesScreen() {
  const { comp: segment } = useLocalSearchParams<{ comp: string }>();
  const comp = useComp(idFromSegment(segment));
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Organiser’s notes', headerLargeTitle: false }} />
      <StaleBanner query={comp} />
      <QueryGate query={comp} loading="Loading the competition…" notFound="This competition doesn’t exist, or isn’t public.">
        {(data) => <Body comp={data} />}
      </QueryGate>
    </View>
  );
}

function Body({ comp }: { comp: CompDetailData }) {
  const [saved] = useState(comp.organiser_notes ?? '');
  return (
    <NotesForm
      testID="comp-notes"
      label="Notes for every pilot in this competition"
      placeholder={'e.g. Briefing 9:30 at the launch shelter.\nRetrieve leaves from the pub at 6.'}
      hint="Shown on the competition’s page, here and on the website. Plain text; line breaks are kept."
      saved={saved}
      save={(text) => updateComp(comp.comp_id, { organiser_notes: text })}
      onSaved={() => router.back()}
    />
  );
}
