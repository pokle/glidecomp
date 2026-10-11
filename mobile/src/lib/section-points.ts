import type { ScoreExplanationSection } from '@glidecomp/engine';

const tenth = (v: number) => Math.round(v * 10) / 10;

/**
 * "143.4 of 156.2 pts": a component's points beside what it had on offer, so
 * a component that wasn't maxed is scannable without reading a formula (the
 * website's ExplanationSection header). Undefined for a section with no
 * points of its own, such as the flight narrative.
 */
export function sectionPoints(section: Pick<ScoreExplanationSection, 'points' | 'pointsAvailable'>): string | undefined {
  if (section.points === undefined) return undefined;
  return section.pointsAvailable !== undefined
    ? `${tenth(section.points)} of ${tenth(section.pointsAvailable)} pts`
    : `${tenth(section.points)} pts`;
}
