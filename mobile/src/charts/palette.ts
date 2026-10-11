/**
 * Chart ink, light and dark: the website's tokens (web/frontend globals.css),
 * which are Apple's system colours, so a chart reads the same on both.
 */
import { useColorScheme } from 'react-native';

export interface ChartPalette {
  /** The subject: the formula's line, the reader's own label. */
  ink: string;
  /** Axis numbers, captions, everyone who is not the reader. */
  muted: string;
  /** Gridlines and the lane. */
  grid: string;
  /** The surface behind the chart, for halos and dot rings. */
  surface: string;
  /** The reader's own mark (chart-1). */
  accent: string;
  /** The cleaned line and its repaired stretches (chart-2). Raw GPS is the
   *  accent, as on the website. */
  cleaned: string;
  /** Raw barometric altitude in the cleaning chart (chart-3). */
  baro: string;
  /** An explanation row flagged as a scoring caveat. */
  warning: string;
  /** Wind (chart-4). */
  wind: string;
  /** Cloud base (chart-5); the thermal top is `baro`'s chart-3. */
  cloudBase: string;
  /** A lane's empty bed, so 0% reads as measured-and-clear. */
  bed: string;
}

const LIGHT: ChartPalette = {
  ink: '#1d1d1f',
  muted: '#5f5f65',
  grid: 'rgba(0,0,0,0.12)',
  surface: '#ffffff',
  accent: '#007aff',
  cleaned: '#34c759',
  baro: '#ff9500',
  warning: '#d97706',
  wind: '#af52de',
  cloudBase: '#ff2d55',
  bed: 'rgba(120,120,128,0.12)',
};

const DARK: ChartPalette = {
  ink: '#f5f5f7',
  muted: '#a1a1a6',
  grid: 'rgba(255,255,255,0.14)',
  surface: '#1c1c1e',
  accent: '#0a84ff',
  cleaned: '#30d158',
  baro: '#ff9f0a',
  warning: '#f59e0b',
  wind: '#bf5af2',
  cloudBase: '#ff375f',
  bed: 'rgba(120,120,128,0.24)',
};

export function useChartPalette(): ChartPalette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

/** The size chart labels are drawn at, in points: the platform's footnote. */
export const CHART_FONT = 12;
