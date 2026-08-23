// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from 'vitest';
import { isPublicCompLink } from './public-deep-link';

describe('isPublicCompLink', () => {
  it('accepts the link the report card writes', () => {
    expect(isPublicCompLink('?compId=abc&taskId=def&pilotId=ghi')).toBe(true);
  });

  it('accepts the whole field — pilotId only narrows a view that is public either way', () => {
    expect(isPublicCompLink('?compId=abc&taskId=def')).toBe(true);
  });

  it('ignores the feature toggles, which carry no data', () => {
    expect(isPublicCompLink('?compId=abc&taskId=def&3d=1&speed=1&track-visible=0')).toBe(true);
  });

  it('rejects a bare page', () => {
    expect(isPublicCompLink('')).toBe(false);
    expect(isPublicCompLink('?')).toBe(false);
  });

  it('rejects half a competition link', () => {
    expect(isPublicCompLink('?compId=abc')).toBe(false);
    expect(isPublicCompLink('?taskId=def')).toBe(false);
    expect(isPublicCompLink('?compId=&taskId=def')).toBe(false);
    expect(isPublicCompLink('?compId=abc&taskId=')).toBe(false);
  });

  // The whole point of the narrow rule: a competition link cannot be used to
  // smuggle one of the other load paths past the sign-in gate.
  it('rejects a competition link carrying any other load path', () => {
    for (const extra of [
      'track=x.igc',
      'task=buje',
      'storedTrack=1',
      'storedTask=buje',
      'sampleComp=corryong-cup-2026-open-t1',
      'shared=1',
      'u=someone',
    ]) {
      expect(isPublicCompLink(`?compId=abc&taskId=def&${extra}`), extra).toBe(false);
    }
  });

  it('accepts a search string without its leading question mark', () => {
    expect(isPublicCompLink('compId=abc&taskId=def')).toBe(true);
  });
});
