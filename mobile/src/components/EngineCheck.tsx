import { useTheme } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { runEngineCheck, type EngineCheckResult } from '@/engine-check/run-engine-check';
import { SAMPLE } from '@/engine-check/sample.generated';

type State =
  | { kind: 'running' }
  | { kind: 'done'; result: EngineCheckResult }
  | { kind: 'failed'; message: string };

/** Which JavaScript engine is running this — the whole point of the check. */
const JS_ENGINE = 'HermesInternal' in globalThis ? 'Hermes' : 'JSC or Node';

/**
 * Stage 1's proof that the engine runs on the phone: scores a bundled sample
 * and prints what the website and AirScore print for it (AirScore publishes
 * 78.85 km, Jon Durand on 1000, start 15:30:00).
 */
export function EngineCheck() {
  const { colors } = useTheme();
  const [state, setState] = useState<State>({ kind: 'running' });

  useEffect(() => {
    runEngineCheck(SAMPLE).then(
      (result) => setState({ kind: 'done', result }),
      (err: unknown) => setState({ kind: 'failed', message: String(err) }),
    );
  }, []);

  const text = [styles.line, { color: colors.text }];
  return (
    <View testID="engine-check" style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]} accessibilityRole="header">
        Engine check
      </Text>
      {state.kind === 'running' && <Text style={text}>Scoring the sample…</Text>}
      {state.kind === 'failed' && (
        <Text testID="engine-check-error" style={text}>
          Failed: {state.message}
        </Text>
      )}
      {state.kind === 'done' && (
        <>
          <Text style={text}>{state.result.taskName}</Text>
          <Text testID="engine-check-distance" style={text}>
            Task distance {state.result.distanceKm} km
          </Text>
          <Text testID="engine-check-winner" style={text}>
            {state.result.winner.name}, {state.result.winner.points} points
          </Text>
          <Text testID="engine-check-times" style={text}>
            Start {state.result.winner.start}, ESS {state.result.winner.ess} ({state.result.zone})
          </Text>
          <Text style={[text, styles.muted]}>
            {state.result.pilotsScored} pilots scored in {state.result.elapsedMs} ms on {JS_ENGINE}
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 6 },
  heading: { fontSize: 17, fontWeight: '600', marginBottom: 4 },
  line: { fontSize: 15 },
  muted: { opacity: 0.6 },
});
