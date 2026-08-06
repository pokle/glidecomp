/**
 * Competition ranking helpers for the section headers — "3rd fastest of 12",
 * "Equal best of 41" — and the ordinal they are built from.
 */

/**
 * Competition rank of `mine` among `values`: 1 + the number strictly better.
 * `tied` is true when another entry shares the exact value (`values` includes
 * this pilot's own, so a shared value counts twice).
 */
export function rankAmong(
  values: number[],
  mine: number,
  better: (candidate: number, mine: number) => boolean,
): { position: number; of: number; tied: boolean } {
  let ahead = 0;
  let equal = 0;
  for (const v of values) {
    if (better(v, mine)) ahead++;
    else if (v === mine) equal++;
  }
  return { position: ahead + 1, of: values.length, tied: equal > 1 };
}

/** "3rd fastest of 12", "Fastest of 12", "Equal fastest of 12". */
export function rankLabel(
  r: { position: number; of: number; tied: boolean },
  superlative: string,
): string {
  const place =
    r.position === 1 ? superlative : `${ordinal(r.position)} ${superlative}`;
  const label = `${r.tied ? 'equal ' : ''}${place} of ${r.of}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}
