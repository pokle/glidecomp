/**
 * Similar pilots (stage 8): who flew most like a chosen pilot on this task,
 * over every behaviour the analysis measured — the engine's own
 * `findSimilarPilots`, computed here from the stored report as the website
 * does. Below the noise floor a match could be chance, and the row says so;
 * pilots who could not be compared are listed, never dropped.
 */
import { findSimilarPilots } from '@glidecomp/engine';
import { useMemo, useState } from 'react';

import { AnalysisFrame } from '@/analysis/AnalysisFrame';
import { useAnalysis } from '@/analysis/use-analysis';
import { useRegistrations } from '@/api/queries';
import { useUserId } from '@/auth/session';
import { ChoiceRow } from '@/ui/choice-row';
import { Group, Note, Row } from '@/ui/grouped-list';

export default function SimilarPilots() {
  const view = useAnalysis();
  const mine = useRegistrations(useUserId()).data?.find((r) => r.comp_id === view.compId);
  const [chosen, setChosen] = useState<string | null>(null);
  const pilots = view.report?.pilots ?? [];
  // Start on the reader's own track when they flew this task, else the winner.
  const own = mine ? pilots.find((p) => p.pilotName === mine.registered_pilot_name)?.trackFile : undefined;
  const subject = chosen ?? own ?? pilots[0]?.trackFile ?? '';
  const result = useMemo(
    () => (view.report && subject ? findSimilarPilots(view.report, { subjectTrackFile: subject }) : null),
    [view.report, subject],
  );
  return (
    <AnalysisFrame view={view} title="Similar pilots" testID="analysis-similar">
      {() => [
        <Group key="who">
          <ChoiceRow
            testID="similar-subject"
            title="Pilot"
            value={subject}
            choices={pilots.map((p) => ({ value: p.trackFile, label: `${p.rank}. ${p.pilotName}` }))}
            onChange={setChosen}
            stacked
          />
        </Group>,
        ...(result
          ? [
              <Group key="list" title={`Most like ${result.subject.pilotName}`} testID="similar-list">
                {result.neighbours.slice(0, 20).map((n) => (
                  <Row
                    key={n.trackFile}
                    title={n.pilotName}
                    value={result.ranking === 'gap' ? `gap ${n.typicalGap.toFixed(2)}` : n.similarity.toFixed(2)}
                    detail={`${n.sharedMetrics} behaviours compared${n.aboveNoiseFloor ? '' : ' · could be chance'}`}
                  />
                ))}
              </Group>,
              ...(result.skipped.length > 0
                ? [
                    <Group key="skipped" title="Not compared">
                      {result.skipped.map((s) => (
                        <Row key={s.trackFile} title={s.pilotName} detail={s.reason} />
                      ))}
                    </Group>,
                  ]
                : []),
              <Group key="how" title="How this is measured">
                <Note>{result.explanation}</Note>
              </Group>,
            ]
          : [<Group key="none"><Note>No comparable behaviours for this pilot on this task.</Note></Group>]),
      ]}
    </AnalysisFrame>
  );
}
