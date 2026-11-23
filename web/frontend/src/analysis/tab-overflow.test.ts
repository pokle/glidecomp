// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from 'vitest';
import { overflowEnds } from './tab-overflow';

describe('overflowEnds', () => {
  it('shows no fade on a row that fits', () => {
    expect(overflowEnds({ scrollLeft: 0, scrollWidth: 319, clientWidth: 319 })).toEqual({
      start: false,
      end: false,
    });
  });

  it('ignores a sub-pixel overflow from rounding', () => {
    expect(overflowEnds({ scrollLeft: 0, scrollWidth: 320, clientWidth: 319 })).toEqual({
      start: false,
      end: false,
    });
  });

  it('fades the end of a row that runs past it', () => {
    expect(overflowEnds({ scrollLeft: 0, scrollWidth: 315, clientWidth: 199 })).toEqual({
      start: false,
      end: true,
    });
  });

  it('fades both ends of a row scrolled part way', () => {
    expect(overflowEnds({ scrollLeft: 50, scrollWidth: 315, clientWidth: 199 })).toEqual({
      start: true,
      end: true,
    });
  });

  it('fades only the start of a row scrolled to its end', () => {
    expect(overflowEnds({ scrollLeft: 116, scrollWidth: 315, clientWidth: 199 })).toEqual({
      start: true,
      end: false,
    });
  });
});
