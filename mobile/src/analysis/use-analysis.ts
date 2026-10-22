/**
 * One task's analysis, as every analysis screen reads it: the report fetched
 * once (and polled while pending), the class the reader chose — carried in
 * the route's `class` parameter so it survives the walk between screens, as
 * the website's `?class=` does — and the report with its values in the
 * reader's units. Render from `report`, never from the raw class report.
 */
import { metricsByFamily } from '@glidecomp/client/analysis';
import { displayReport } from '@glidecomp/client/analysis-units';
import { idFromSegment } from '@glidecomp/client/slug';
import { clusterPilotStyles } from '@glidecomp/engine';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';

import { useComp, useTask, useTaskAnalysis, useTaskWeather } from '@/api/queries';
import { useUnits } from '@/settings/units';

export function useAnalysis() {
  const params = useLocalSearchParams<{ comp: string; task: string; class?: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const prefs = useUnits();
  const analysis = useTaskAnalysis(compId, taskId);
  const comp = useComp(compId);
  const task = useTask(compId, taskId);
  const weather = useTaskWeather(compId, taskId);
  const classes = analysis.data?.classes ?? [];
  const selectedClass =
    params.class && classes.some((c) => c.pilot_class === params.class) ? params.class : (classes[0]?.pilot_class ?? '');
  const active = classes.find((c) => c.pilot_class === selectedClass);
  const report = useMemo(() => (active ? displayReport(active.report, prefs) : null), [active, prefs]);
  const styleClusters = useMemo(() => (report ? clusterPilotStyles(report) : null), [report]);
  const dayMetrics = useMemo(() => (report ? (metricsByFamily(report.metrics).get('day') ?? []) : []), [report]);
  const weatherNotes = weather.data?.notes ?? task.data?.weather_notes ?? '';
  const hasWeatherSection = weatherNotes.trim().length > 0 || dayMetrics.length > 0 || !!weather.data?.weather;
  const hasThermalsSection = !!report?.thermals && report.thermals.shapes.length > 0;
  const base = `/comp/${params.comp}/task/${params.task}/analysis`;
  const query = selectedClass ? `?class=${encodeURIComponent(selectedClass)}` : '';
  return {
    compId,
    taskId,
    analysis,
    comp: comp.data,
    task: task.data,
    timeZone: comp.data?.timezone ?? null,
    classes,
    selectedClass,
    selectClass: (pilotClass: string) => router.setParams({ class: pilotClass }),
    active,
    report,
    styleClusters,
    dayMetrics,
    weather: weather.data,
    weatherNotes,
    hasWeatherSection,
    hasThermalsSection,
    /** A path inside this task's analysis, carrying the chosen class. */
    href: (rest = '') => `${base}${rest}${query}`,
  };
}

export type AnalysisView = ReturnType<typeof useAnalysis>;
