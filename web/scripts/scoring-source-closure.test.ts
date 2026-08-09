/**
 * Tests the walk that decides WHICH files the scoring fingerprint hashes.
 *
 * This is a guard on a guard, and it earns its place because the failure it
 * catches is invisible. A file the walk misses does not break a test — the
 * fingerprint simply stops covering it, and the next change to it ships
 * without the version bump that keeps two engine generations from serving
 * contradictory cached scores. Nothing goes red. So the traversal's edges are
 * asserted here directly, over an in-memory tree, rather than inferred from
 * whichever import spellings the engine's sources happen to use this month.
 */

import { describe, it, expect } from 'bun:test';
import {
  resolveRelativeImport,
  scoringSourceFiles,
  virtualSourceTree,
} from './scoring-source-closure';

describe('scoring source closure', () => {
  it('follows an import into a subdirectory', () => {
    // The regression this module exists for. The previous walk matched
    // `from './x'` with a pattern that excluded '/', so a scoring helper moved
    // into a subdirectory silently left the fingerprint.
    const tree = virtualSourceTree({
      'gap-scoring.ts': `import { step } from './steps/leading';`,
      'steps/leading.ts': `export const step = 1;`,
    });
    expect(scoringSourceFiles(['gap-scoring.ts'], tree)).toEqual([
      'gap-scoring.ts',
      'steps/leading.ts',
    ]);
  });

  it('resolves a specifier against the importing file, not the root', () => {
    // './stats' inside field-analysis/ means field-analysis/stats.ts. Joining
    // it onto the root instead would silently hash the wrong file — or, worse,
    // a real file of the same name that is not the dependency at all.
    const tree = virtualSourceTree({
      'stats.ts': `export const wrong = true;`,
      'root.ts': `import './field-analysis/shape';`,
      'field-analysis/shape.ts': `import { percentile } from './stats';`,
      'field-analysis/stats.ts': `export const percentile = 1;`,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual([
      'field-analysis/shape.ts',
      'field-analysis/stats.ts',
      'root.ts',
    ]);
  });

  it('follows a parent-relative import back out of a subdirectory', () => {
    const tree = virtualSourceTree({
      'root.ts': `import './sub/deep';`,
      'sub/deep.ts': `import { andoyerDistance } from '../geo';`,
      'geo.ts': `export const andoyerDistance = 1;`,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual([
      'geo.ts',
      'root.ts',
      'sub/deep.ts',
    ]);
  });

  it('follows every spelling that creates a dependency', () => {
    // A re-export carries code as surely as an import; a side-effect import
    // runs it; a dynamic import defers it. Missing any one is a silent hole.
    const tree = virtualSourceTree({
      'root.ts': `
        import { a } from './named';
        import type { B } from './type-only';
        export * from './re-exported';
        export { c } from './re-exported-named';
        import './side-effect';
        const d = await import('./dynamic');
        import {
          e,
        } from './multi-line';
      `,
      'named.ts': ``,
      'type-only.ts': ``,
      're-exported.ts': ``,
      're-exported-named.ts': ``,
      'side-effect.ts': ``,
      'dynamic.ts': ``,
      'multi-line.ts': ``,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual([
      'dynamic.ts',
      'multi-line.ts',
      'named.ts',
      're-exported-named.ts',
      're-exported.ts',
      'root.ts',
      'side-effect.ts',
      'type-only.ts',
    ]);
  });

  it('ignores bare package specifiers', () => {
    const tree = virtualSourceTree({
      'root.ts': `
        import * as turf from '@turf/turf';
        import { readFileSync } from 'node:fs';
        import { local } from './local';
      `,
      'local.ts': ``,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual(['local.ts', 'root.ts']);
  });

  it('resolves a directory import to its index, and an explicit extension', () => {
    const tree = virtualSourceTree({
      'root.ts': `import './pkg'; import './explicit.ts';`,
      'pkg/index.ts': ``,
      'explicit.ts': ``,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual([
      'explicit.ts',
      'pkg/index.ts',
      'root.ts',
    ]);
  });

  it('terminates on an import cycle and lists each file once', () => {
    const tree = virtualSourceTree({
      'a.ts': `import './b';`,
      'b.ts': `import './a'; import './c';`,
      'c.ts': `import './b';`,
    });
    expect(scoringSourceFiles(['a.ts'], tree)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('dedupes a file reached from two roots', () => {
    const tree = virtualSourceTree({
      'one.ts': `import './shared';`,
      'two.ts': `import './shared';`,
      'shared.ts': ``,
    });
    expect(scoringSourceFiles(['one.ts', 'two.ts'], tree)).toEqual([
      'one.ts',
      'shared.ts',
      'two.ts',
    ]);
  });

  it('refuses to skip a specifier that resolves to nothing', () => {
    // The load-bearing assertion. Skipping silently is precisely how coverage
    // is lost, so an unresolvable import must stop the build instead.
    const tree = virtualSourceTree({ 'root.ts': `import './gone';` });
    expect(() => scoringSourceFiles(['root.ts'], tree)).toThrow(/resolves to no file/);
  });

  it('refuses an import that escapes the source root', () => {
    const tree = virtualSourceTree({ 'root.ts': `import '../outside/thing';` });
    expect(() => scoringSourceFiles(['root.ts'], tree)).toThrow(
      /resolves outside the engine's src\/ directory/,
    );
  });

  it('names the importing file and the specifier when it gives up', () => {
    // The message is the whole remedy: whoever hits this has to know which
    // import to fix, and that skipping it was not an option the guard had.
    const tree = virtualSourceTree({ 'sub/mod.ts': `import './missing';` });
    expect(() => scoringSourceFiles(['sub/mod.ts'], tree)).toThrow(/sub\/mod\.ts/);
    expect(() => scoringSourceFiles(['sub/mod.ts'], tree)).toThrow(/'\.\/missing'/);
  });

  it('normalises a redundant path segment to one entry', () => {
    const tree = virtualSourceTree({
      'root.ts': `import './sub/../geo'; import './geo';`,
      'geo.ts': ``,
    });
    expect(scoringSourceFiles(['root.ts'], tree)).toEqual(['geo.ts', 'root.ts']);
  });

  it('resolves a bare specifier the same way from any depth', () => {
    const tree = virtualSourceTree({ 'a/b/c.ts': ``, 'a/b/d.ts': `` });
    expect(resolveRelativeImport('a/b/d.ts', './c', virtualSourceTree({ 'a/b/c.ts': '' })))
      .toBe('a/b/c.ts');
    expect(resolveRelativeImport('a/b/d.ts', '../b/c', virtualSourceTree({ 'a/b/c.ts': '' })))
      .toBe('a/b/c.ts');
  });
});
