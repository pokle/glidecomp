/**
 * What the pilot-similarity pages read: one task's report, and one pilot
 * compared with the rest of the class on the behaviours the URL names.
 *
 * Two pages share it — the results ("Who flew like me?") and the comparison
 * of one pair that a row of the results opens — so the two cannot disagree
 * about the class, the subject or the behaviours. Everything that picks them
 * is in the URL (`?class=`, `?pilot=`, `?metrics=`), so a reload and a shared
 * link open the same page, and nothing is handed over in memory.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../comp/api";
import { fetchWithRetry, type CompDetailData, type TaskDetailData } from "../comp/types";
import { idFromSegment } from "../lib/slug";
import { useUnits } from "../lib/units";
import { findSimilarPilots, type TaskAnalysisData } from "./types";
import { displayReport } from "./units";

export const SIMILARITY_PILOT_PARAM = "pilot";
export const SIMILARITY_CLASS_PARAM = "class";
export const SIMILARITY_METRICS_PARAM = "metrics";
/** On the pair's page: the pilot the subject is compared with, by name. */
export const SIMILARITY_WITH_PARAM = "with";
/** The results page's name: its title, and the pair page's way back. */
export const SIMILARITY_LABEL = "Who flew like me?";

export function useSimilarity() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<TaskAnalysisData | null>(null);
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notFound" | "error">(
    "loading"
  );

  // The report these pages derive from. Through fetchWithRetry rather than a
  // bare fetch: "notFound" is a terminal state nothing re-fetches, so a
  // dropped request must not be recorded as "no such task" (issue #481).
  useEffect(() => {
    if (!compId || !taskId) return;
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const res = await fetchWithRetry(() =>
          fetch(
            `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/analysis`,
            { credentials: "include" }
          )
        );
        if (cancelled) return;
        if (res.status === 404 || res.status === 400) {
          setStatus("notFound");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        setData((await res.json()) as TaskAnalysisData);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId]);

  // Names for the heading and the bar. Cosmetic — the pages work without.
  useEffect(() => {
    if (!compId || !taskId) return;
    let cancelled = false;
    (async () => {
      try {
        const [taskRes, compRes] = await Promise.all([
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: compId, task_id: taskId },
          }),
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } }),
        ]);
        if (cancelled) return;
        if (taskRes.ok) setTask((await taskRes.json()) as unknown as TaskDetailData);
        if (compRes.ok) setComp((await compRes.json()) as unknown as CompDetailData);
      } catch {
        // Cosmetic only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId]);

  const classes = data?.classes ?? [];
  const classParam = searchParams.get(SIMILARITY_CLASS_PARAM);
  const selectedClass =
    classParam && classes.some((c) => c.pilot_class === classParam)
      ? classParam
      : (classes[0]?.pilot_class ?? "");
  const active = classes.find((c) => c.pilot_class === selectedClass);

  // Values converted to the viewer's units for DISPLAY. A z-score and the
  // cosine are both invariant under the linear conversion — that is the point
  // of normalising — so the geometry is identical either way and this only
  // changes the raw numbers printed beside each z.
  const units = useUnits();
  const report = useMemo(
    () => (active ? displayReport(active.report, units) : null),
    [active, units]
  );

  // Task rank by track file, for the label beside each name. The report's
  // pilot list is already in rank order and carries the rank outright, so this
  // costs no extra request and cannot disagree with the scores page.
  const rankByTrack = useMemo(
    () => new Map((report?.pilots ?? []).map((p) => [p.trackFile, p.rank])),
    [report]
  );

  // Every behaviour this field offers, in registry order. `outcome` metrics
  // are absent by construction — findSimilarPilots refuses them, and they are
  // score-derived, which is exactly what these pages are not about.
  const available = useMemo(() => {
    if (!report) return [];
    // Ask the engine which metrics are usable by running it over everything:
    // the returned `metrics` array IS the usable set, so the checkbox list and
    // the vectors can never disagree about what is on offer.
    const probe = report.pilots[0]
      ? findSimilarPilots(report, { subjectTrackFile: report.pilots[0].trackFile })
      : null;
    return probe?.metrics ?? [];
  }, [report]);

  // Selection: the URL when it names metrics still on offer, otherwise all of
  // them. A metric that left the registry is dropped rather than erroring —
  // a saved link outlives a metric set.
  const metricsParam = searchParams.get(SIMILARITY_METRICS_PARAM);
  const selectedMetricIds = useMemo(() => {
    const ids = available.map((m) => m.id);
    if (metricsParam === null) return ids;
    const wanted = new Set(metricsParam.split(",").filter(Boolean));
    const kept = ids.filter((id) => wanted.has(id));
    return kept.length > 0 ? kept : ids;
  }, [metricsParam, available]);

  // The subject. The NAME rather than the trackFile, matching PilotPicker: a
  // URL a person can read beats an internal filename. An unresolvable name
  // falls back to the first pilot rather than rendering nothing.
  const pilotParam = searchParams.get(SIMILARITY_PILOT_PARAM);
  const subject =
    (pilotParam ? report?.pilots.find((p) => p.pilotName === pilotParam) : null) ??
    report?.pilots[0] ??
    null;

  const similarity = useMemo(() => {
    if (!report || !subject) return null;
    return findSimilarPilots(report, {
      subjectTrackFile: subject.trackFile,
      metricIds: selectedMetricIds,
    });
  }, [report, subject, selectedMetricIds]);

  return {
    compId,
    taskId,
    searchParams,
    setSearchParams,
    status,
    task,
    comp,
    classes,
    selectedClass,
    report,
    rankByTrack,
    available,
    metricsParam,
    selectedMetricIds,
    subject,
    similarity,
  };
}
