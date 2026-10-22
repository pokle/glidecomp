/**
 * Settings → Scoring: format, series scoring, FAI Class 2, and the GAP
 * parameters behind an Advanced switch — the website's ScoringSettings, with
 * its values, reset and PATCH body from @glidecomp/client/scoring-settings so
 * the two cannot save a formula differently. Every field is a scoring input:
 * the server audits each change and re-scores every task.
 */
import {
  scoringDefaults,
  scoringFormValues,
  scoringPatch,
  wingOf,
  type ScoringFormValues,
} from '@glidecomp/client/scoring-settings';
import type { CompDetailData } from '@glidecomp/client/types';
import { useRef, useState } from 'react';

import { updateComp } from '@/api/organiser';
import { CompSettingsScreen } from '@/components/CompSettingsScreen';
import { SettingsForm } from '@/components/SettingsForm';
import { Choices, Field, FormCard, FormHint, TextButton, Toggle } from '@/ui/form';
import { useFormSave } from '@/ui/use-form-save';

export default function ScoringSettings() {
  return <CompSettingsScreen title="Scoring">{(comp) => <Form comp={comp} />}</CompSettingsScreen>;
}

/** A number typed into a field: NaN for empty, so "auto" survives. */
const parse = (text: string) => (text.trim() === '' ? NaN : Number(text));
const show = (n: number) => (Number.isNaN(n) ? '' : String(n));

function Form({ comp }: { comp: CompDetailData }) {
  const wing = wingOf(comp);
  const [v, setV] = useState<ScoringFormValues>(() => scoringFormValues(comp));
  const saved = useRef(JSON.stringify(v));
  const [advanced, setAdvanced] = useState(false);
  const { saving, note, run } = useFormSave();
  const dirty = JSON.stringify(v) !== saved.current;
  const set = <K extends keyof ScoringFormValues>(k: K) => (value: ScoringFormValues[K]) => setV((x) => ({ ...x, [k]: value }));
  const num = (k: 'nominalDistance' | 'nominalTime' | 'minimumDistance' | 'jtgFactor' | 'jtgMax' | 'essNotGoal' | 'leadingTimeRatio') => ({
    value: show(v[k]),
    onChangeText: (text: string) => set(k)(parse(text)),
    keyboardType: 'decimal-pad' as const,
  });

  async function save() {
    const ok = await run(() => updateComp(comp.comp_id, scoringPatch(v, comp)), 'Saved. Every task is being scored again.');
    if (ok !== undefined) saved.current = JSON.stringify(v);
  }

  const gap = v.scoringFormat !== 'open_distance';
  return (
    <SettingsForm dirty={dirty} saving={saving} note={note} onSave={() => void save()} testID="settings-scoring-form">
      <FormCard>
        <Choices
          label="Scoring format"
          value={v.scoringFormat}
          choices={[
            { value: 'gap', label: 'GAP' },
            { value: 'open_distance', label: 'Open distance' },
          ]}
          onChange={set('scoringFormat')}
          testID="settings-format"
        />
        <FormHint>
          GAP is race to goal or elapsed time. Open distance scores metres flown from the take-off exit; each task has a single
          Takeoff turnpoint and no goal.
        </FormHint>
        {v.scoringFormat === 'gap' ? (
          <>
            <Choices
              label="Series scoring"
              value={v.seriesScoring}
              choices={[
                { value: 'total', label: 'Sum of task scores' },
                { value: 'ftv', label: 'FTV' },
              ]}
              onChange={set('seriesScoring')}
              testID="settings-series"
            />
            <FormHint>
              FTV (S7F §16) scores each pilot on their best tasks, discarding a fixed fraction of the total validity — the
              paragliding norm. Sum of task scores is the simple total.
            </FormHint>
            {v.seriesScoring === 'ftv' ? (
              <Choices
                label="FTV discard fraction"
                value={v.ftvFactorPct}
                choices={[
                  { value: '', label: 'Automatic' },
                  { value: '20', label: '20%' },
                  { value: '25', label: '25%' },
                ]}
                onChange={set('ftvFactorPct')}
              />
            ) : null}
          </>
        ) : null}
      </FormCard>

      {gap && wing === 'hg' && comp.pilot_classes.length > 0 ? (
        <FormCard title="FAI Class 2 classes">
          {comp.pilot_classes.map((c) => (
            <Toggle
              key={c}
              label={c}
              value={v.class2Classes.includes(c)}
              onChange={(on) => set('class2Classes')(on ? [...v.class2Classes, c] : v.class2Classes.filter((x) => x !== c))}
            />
          ))}
          <FormHint>
            FAI S7F §11: a class flying Class 2 — rigid wings with movable aerodynamic surfaces — scores no arrival points, and
            their share goes to time. Turn on the classes that fly Class 2.
          </FormHint>
        </FormCard>
      ) : null}

      {gap ? (
        <FormCard title="Advanced scoring settings">
          <Toggle label="Show the GAP parameters" value={advanced} onChange={setAdvanced} testID="settings-advanced" />
          {advanced ? (
            <>
              <FormHint>
                These are the official CIVL GAP defaults for your competition wing. Changing them will make your scores differ
                from a standard FAI / AirScore result. Only edit these if your competition runs under local rules (e.g. SAFA) that
                specify different values, or you have a specific technical reason.
              </FormHint>
              <TextButton title="Reset to defaults" onPress={() => setV((x) => scoringDefaults(wing, x))} testID="settings-reset" />
              <Field label="Nominal distance (km)" placeholder="auto" {...num('nominalDistance')} />
              <FormHint>Blank = auto (70% of task)</FormHint>
              <Field label="Nominal time (min)" {...num('nominalTime')} />
              <Field label="Minimum distance (km)" {...num('minimumDistance')} />
              <Field label="Jump-the-gun: seconds per penalty point (HG)" {...num('jtgFactor')} />
              <FormHint>
                FAI S7F §13.3: an HG pilot starting early loses 1 point per this many seconds. Spec default 2. No effect on PG.
              </FormHint>
              <Field label="Jump-the-gun: maximum seconds early (HG)" {...num('jtgMax')} />
              <FormHint>Starting earlier than this scores minimum distance only. Spec default 300.</FormHint>
              <Field label="ESS but not goal: points kept (%, HG)" {...num('essNotGoal')} />
              <FormHint>
                FAI S7F §13.2: an HG pilot who reaches ESS but lands before goal keeps this share of their time and arrival points.
                Spec default 80.
              </FormHint>
              <Toggle label="Leading (departure) points" value={v.useLeading} onChange={set('useLeading')} />
              <Toggle label="Arrival points (HG only)" value={v.useArrival} onChange={set('useArrival')} />
              <Toggle
                label="Distance difficulty (HG only)"
                hint="Splits HG distance points half linear, half difficulty (FAI S7F). No effect on PG."
                value={v.useDifficulty}
                onChange={set('useDifficulty')}
              />
              <Field label="Leading-time ratio (%)" {...num('leadingTimeRatio')} />
              <FormHint>
                {wing === 'pg'
                  ? 'FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 26%). The rest goes to time.'
                  : 'FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 17.5%). The rest goes to time and arrival.'}
              </FormHint>
              <Choices
                label="Distance origin"
                value={v.distanceOrigin}
                choices={[
                  { value: 'takeoff', label: 'Take-off (default)' },
                  { value: 'start', label: 'Start cylinder' },
                ]}
                onChange={set('distanceOrigin')}
              />
              <FormHint>
                Where scored distance begins for tasks with a take-off turnpoint. Take-off is FAI CIVL GAP / PWCA; Start cylinder
                (HGFA, “Move Origin”) excludes the take-off→SSS leg.
              </FormHint>
            </>
          ) : null}
        </FormCard>
      ) : null}
    </SettingsForm>
  );
}
