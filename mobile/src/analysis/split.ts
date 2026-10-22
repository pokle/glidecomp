import type { FieldAirtimeSplit } from '@glidecomp/engine';

/** "52% climbing · 31% gliding · 17% searching": the airtime split in words. */
export function splitText(split: FieldAirtimeSplit): string {
  return `${Math.round(split.climbPct)}% climbing · ${Math.round(split.glidePct)}% gliding · ${Math.round(split.searchPct)}% searching`;
}
