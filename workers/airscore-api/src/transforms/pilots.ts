/**
 * Extract pilot results from AirScore data array
 */

import type { AirScoreDataRow, PilotResult } from '../types';

/**
 * Parse HTML to extract pilot name and track ID from the name link
 *
 * Example input: '<a href="tracklog_map.html?trackid=43826&comPk=466&tasPk=2030">Rory Duncan</a>'
 * Returns: { name: 'Rory Duncan', trackId: '43826' }
 */
function parseNameLink(html: string): { name: string; trackId?: string } {
  const linkMatch = html.match(
    /<a href="tracklog_map\.html\?trackid=(\d+)[^"]*">([^<]+)<\/a>/
  );

  if (linkMatch) {
    return {
      name: linkMatch[2],
      trackId: linkMatch[1],
    };
  }

  // Fallback: strip any HTML tags and return as name
  return {
    name: html.replace(/<[^>]+>/g, '').trim(),
  };
}

/**
 * Parse rank value, stripping HTML bold tags
 *
 * Example: '<b>1</b>' -> 1
 */
function parseRank(value: string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  const stripped = value.replace(/<[^>]+>/g, '');
  return parseInt(stripped, 10) || 0;
}

/**
 * Safely parse a numeric value
 */
function parseNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = parseFloat(value);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Safely parse a string value
 */
function parseString(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  return String(value);
}

/**
 * Extract pilot results from AirScore data array
 *
 * AirScore data row format (indices):
 * [0]  rank         - e.g., '<b>1</b>'
 * [1]  pilotId      - e.g., '199463'
 * [2]  nameLink     - e.g., '<a href="tracklog_map.html?trackid=43826&comPk=466&tasPk=2030">Rory Duncan</a>'
 * [3]  nationality  - e.g., 'AUS'
 * [4]  glider       - e.g., 'Airborne REV 13.5'
 * [5]  gliderClass  - e.g., 'C'
 * [6]  startTime    - e.g., '15:00:00' or ''
 * [7]  finishTime   - e.g., '16:52:18' or ''
 * [8]  duration     - e.g., '1:52:18' or ''
 * [9]  penalty      - e.g., '' (unused)
 * [10] distance     - e.g., 80.47
 * [11] departure    - e.g., 0 (unused)
 * [12] leadout      - e.g., 0 (unused)
 * [13] arrival      - e.g., 140.6
 * [14] speed        - e.g., 859.4
 * [15] flown        - e.g., '' (unused)
 * [16] score        - e.g., 1000
 */
export function extractPilotResults(data: AirScoreDataRow[]): PilotResult[] {
  return data.map((row) => {
    const [
      rank,
      pilotId,
      nameLink,
      nationality,
      glider,
      gliderClass,
      startTime,
      finishTime,
      duration,
      _penalty,
      distance,
      _departure,
      _leadout,
      _arrival,
      speed,
      _flown,
      score,
    ] = row;

    const { name, trackId } = parseNameLink(String(nameLink || ''));

    return {
      rank: parseRank(rank as string | number),
      pilotId: String(pilotId || ''),
      name,
      nationality: String(nationality || ''),
      glider: String(glider || ''),
      gliderClass: String(gliderClass || ''),
      startTime: parseString(startTime),
      finishTime: parseString(finishTime),
      duration: parseString(duration),
      distance: parseNumber(distance),
      speed: parseNumber(speed),
      score: Math.round(parseNumber(score)),
      trackId,
    };
  });
}
