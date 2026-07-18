// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The metric registry. Report rendering and evaluation are generic over this
 * list, so a metric added to its family array (metrics/*.ts) appears in the
 * report and the correlation ranking with no further wiring.
 *
 * Families print in this order; `day` leads because the day's shape (wind,
 * climb-by-hour) is the context every later number is read against.
 */

import type { MetricComputer, MetricFamily } from './types';
import { DAY_METRICS } from './metrics/day-profile';
import { CLIMBING_METRICS } from './metrics/climbing';
import { GLIDING_METRICS } from './metrics/gliding';
import { DECISION_METRICS } from './metrics/decision';
import { GAGGLE_METRICS } from './metrics/gaggle';
import { RACECRAFT_METRICS } from './metrics/racecraft';

export const FAMILY_ORDER: MetricFamily[] = [
  'day',
  'climbing',
  'gliding',
  'decision',
  'gaggle',
  'racecraft',
];

export const FAMILY_LABELS: Record<MetricFamily, string> = {
  day: 'Day profile & wind',
  climbing: 'Climbing',
  gliding: 'Gliding',
  decision: 'Decision-making',
  gaggle: 'Gaggle',
  racecraft: 'Race craft',
};

export const ALL_METRICS: MetricComputer[] = [
  ...DAY_METRICS,
  ...CLIMBING_METRICS,
  ...GLIDING_METRICS,
  ...DECISION_METRICS,
  ...GAGGLE_METRICS,
  ...RACECRAFT_METRICS,
];
