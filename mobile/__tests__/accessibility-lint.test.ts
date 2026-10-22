/**
 * Two accessibility rules the code can hold itself to (stage 9's audit),
 * checked over every screen and component so they cannot quietly regress:
 *
 * - every `Pressable` says what it is (`accessibilityRole`), so VoiceOver and
 *   TalkBack announce a button as a button;
 * - every chart (`Svg`) is either labelled or inside something hidden from
 *   assistive technology — a chart with neither is an unlabelled image.
 *
 * What a device has to judge — reading order, Dynamic Type at the largest
 * sizes, contrast in both themes — is the checklist in mobile/AUDIT.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.tsx') ? [path] : [];
  });
}

const files = sources(join(__dirname, '..', 'src'));

/** Decorative swatches inside a legend the screen reader is told to skip. */
const DECORATIVE: Record<string, number> = { 'TrackCleaningChart.tsx': 1 };

describe('accessibility lint', () => {
  it('gives every Pressable a role', () => {
    const missing = files.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/<Pressable\b([^>]*?)>/gs)]
        .filter((m) => !m[1].includes('accessibilityRole'))
        .map(() => f),
    );
    expect(missing).toEqual([]);
  });

  it('labels every chart, or hides it with its legend', () => {
    const unlabelled = files.flatMap((f) => {
      const count = [...readFileSync(f, 'utf8').matchAll(/<Svg\b([^>]*?)>/gs)].filter((m) => !/accessib/.test(m[1])).length;
      const allowed = Object.entries(DECORATIVE).find(([name]) => f.endsWith(name))?.[1] ?? 0;
      return count > allowed ? [`${f}: ${count}`] : [];
    });
    expect(unlabelled).toEqual([]);
  });
});
