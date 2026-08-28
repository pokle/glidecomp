/**
 * "Who flew like me?" — PROTOTYPE.
 *
 * An exploratory sheet hung off the task's field analysis: pick a pilot, pick
 * the behaviours you care about, and the field is ranked by the cosine
 * similarity of the resulting vectors. The question is whether this is a
 * useful way to read a field at all, so the page shows its working rather
 * than hiding it — the per-behaviour contributions and the typical-gap column
 * both exist to be argued with.
 *
 * Deliberately NOT about the leaderboard. No score, rank or outcome metric
 * appears anywhere on this page, and findSimilarPilots refuses to let one into
 * the vector (see web/engine/src/field-analysis/similarity.ts). "Similar" here
 * means similar FLYING, and two pilots at opposite ends of the results sheet
 * are expected to sit next to each other whenever they flew alike.
 *
 * There is deliberately NO basis control. An earlier cut offered a choice of
 * normalisation, which read as if it were about the standings (it is not — the
 * comparison is against the field's AVERAGE BEHAVIOUR, never its finishing
 * order) and whose second option existed only to demonstrate why the first was
 * needed. The engine now always takes a z-score, and the page explains that
 * once in "How this is worked out" rather than making the reader choose.
 *
 * Client-only, and listed in the SSR Function's NOINDEX_SHELL_ROUTES: the
 * whole computation is a pure derivation from the stored field-analysis report
 * the page fetches anyway, so there is nothing to server-render and nothing a
 * crawler should keep while the idea is still being tried out.
 *
 * All state round-trips through the URL (`?pilot=`, `?class=`, `?metrics=`) so
 * a reading of the field can be pasted to someone else — which is most of how
 * a prototype gets evaluated.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { ArrowLeftIcon } from "lucide-react";

import { Card } from "@/react/rac/card";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button, LinkButton } from "@/react/rac/button";
import { Checkbox } from "@/react/rac/checkbox";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";

import { NotFound } from "../components/NotFound";
import { api } from "../../comp/api";
import { fetchWithRetry, type CompDetailData, type TaskDetailData } from "../comp/types";
import { underTaskAnalysis } from "../lib/crumbs";
import { idFromSegment, taskAnalysisPath } from "../lib/slug";
import { useUnits } from "../lib/units";
import { cn } from "../lib/utils";
import { displayReport } from "../field-analysis/units";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  formatMetricValue,
  findSimilarPilots,
  type MetricFamily,
  type TaskFieldAnalysisData,
} from "../field-analysis/types";

/** URL parameters this sheet round-trips its whole state through. */
const PILOT_PARAM = "pilot";
const CLASS_PARAM = "class";
const METRICS_PARAM = "metrics";

/** How many neighbours the table shows before the "show everyone" toggle. */
const TOP_N = 12;

/** A signed z-score, e.g. "+1.4 SD" — always with its sign, so above and below
 * the field average are told apart at a glance. */
function fmtZ(z: number): string {
  return `${z >= 0 ? "+" : "−"}${Math.abs(z).toFixed(1)} SD`;
}

/** The similarity as a diverging bar. Colour is never the only channel — the
 * number sits beside it, and the bar is decorative to AT.
 *
 * The scale is asymmetric because the measure is: Tanimoto reaches 1 for two
 * pilots who flew alike but only −1/3 for two who did the opposite, so each
 * side is drawn against its own limit rather than letting a full-strength
 * opposite render as a third of a bar. */
function SimilarityBar({ value, muted }: { value: number; muted?: boolean }) {
  const limit = value >= 0 ? 1 : 1 / 3;
  const half = Math.min(50, (Math.abs(value) / limit) * 50);
  return (
    <span aria-hidden className="relative block h-2 w-24 rounded-full bg-muted">
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span
        className={cn(
          "absolute inset-y-0 rounded-full",
          muted ? "bg-muted-foreground/40" : value >= 0 ? "bg-primary" : "bg-destructive"
        )}
        style={
          value >= 0
            ? { left: "50%", width: `${half}%` }
            : { right: "50%", width: `${half}%` }
        }
      />
    </span>
  );
}

export function TaskPilotSimilarity() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<TaskFieldAnalysisData | null>(null);
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "notFound" | "error">(
    "loading"
  );
  const [showAll, setShowAll] = useState(false);

  // The report this page derives from. Through fetchWithRetry rather than a
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
            `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/field-analysis`,
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
        setData((await res.json()) as TaskFieldAnalysisData);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId]);

  // Names for the heading and breadcrumbs. Cosmetic — the sheet works without.
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
        if (taskRes.ok) {
          const t = (await taskRes.json()) as unknown as TaskDetailData;
          setTask(t);
          document.title = `GlideComp - Who flew like me: ${t.name}`;
        }
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
  const classParam = searchParams.get(CLASS_PARAM);
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

  /** Write one parameter; `null` clears it. */
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  }

  // Every behaviour this field offers, in registry order. `outcome` metrics
  // are absent by construction — findSimilarPilots refuses them, and they are
  // score-derived, which is exactly what this page is not about.
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
  const metricsParam = searchParams.get(METRICS_PARAM);
  const selectedMetricIds = useMemo(() => {
    const ids = available.map((m) => m.id);
    if (metricsParam === null) return ids;
    const wanted = new Set(metricsParam.split(",").filter(Boolean));
    const kept = ids.filter((id) => wanted.has(id));
    return kept.length > 0 ? kept : ids;
  }, [metricsParam, available]);
  const selectedSet = useMemo(() => new Set(selectedMetricIds), [selectedMetricIds]);

  function toggleMetric(id: string, on: boolean) {
    const next = on
      ? available.filter((m) => selectedSet.has(m.id) || m.id === id).map((m) => m.id)
      : selectedMetricIds.filter((m) => m !== id);
    // "Everything" is the default, so it is written as an absent parameter
    // rather than a 26-id query string.
    setParam(
      METRICS_PARAM,
      next.length === available.length ? null : next.join(",")
    );
  }

  // The subject. The NAME rather than the trackFile, matching PilotPicker: a
  // URL a person can read beats an internal filename. An unresolvable name
  // falls back to the first pilot rather than rendering nothing.
  const pilotParam = searchParams.get(PILOT_PARAM);
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

  // Only a set with nothing usable in it has no answer at all — narrowing to a
  // single behaviour is a supported mode (ranked by gap), not an error.
  const nothingUsable = report !== null && subject !== null && similarity === null;
  const byGap = similarity?.ranking === "gap";

  useEffect(() => setShowAll(false), [subject?.trackFile, metricsParam]);

  if (status === "loading") return <Loading>Loading the field analysis…</Loading>;
  if (status === "notFound") return <NotFound />;
  if (status === "error")
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the analysis</AlertTitle>
        <AlertDescription>
          The field analysis for this task could not be fetched. Reload to try again.
        </AlertDescription>
      </Alert>
    );

  const analysisHref = taskAnalysisPath(compId, comp?.name, taskId, task?.name);
  const neighbours = similarity?.neighbours ?? [];
  const shown = showAll ? neighbours : neighbours.slice(0, TOP_N);
  const byFamily = new Map<MetricFamily, typeof available>();
  for (const m of available) {
    const list = byFamily.get(m.family);
    if (list) list.push(m);
    else byFamily.set(m.family, [m]);
  }

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumbs
        items={underTaskAnalysis(compId, comp?.name, taskId, task?.name)}
        current="Who flew like me?"
      />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Who flew like me?</h1>
          <p className="text-sm text-muted-foreground">
            {task?.name ?? "This task"} — pilots ranked by how closely their flying
            matched, over the behaviours you choose. Nothing on this page uses the
            scores or the finishing order.
          </p>
        </div>
        <LinkButton href={analysisHref} variant="outline" size="sm">
          <ArrowLeftIcon className="size-4" />
          Field analysis
        </LinkButton>
      </div>

      <Alert>
        <AlertTitle>Prototype</AlertTitle>
        <AlertDescription>
          This sheet is an experiment in reading a field by behaviour rather than by
          result. The numbers are honest but the idea is still being tried out, so
          treat a similarity score as a prompt to go and look at two tracks, not as a
          verdict.
        </AlertDescription>
      </Alert>

      {report === null || subject === null ? (
        <Card>
          <p className="text-sm text-muted-foreground">
            There is no field analysis for this task yet. Open the{" "}
            <a className="underline" href={analysisHref}>
              field analysis
            </a>{" "}
            first — it computes in the background the first time it is opened.
          </p>
        </Card>
      ) : (
        <>
          <Card aria-labelledby="controls-heading" className="gap-4">
            <h2 id="controls-heading" className="text-lg font-semibold">
              Pick a pilot and the behaviours
            </h2>

            <div className="flex flex-wrap gap-4">
              {classes.length > 1 ? (
                <SimpleSelect
                  label="Class"
                  value={selectedClass}
                  onChange={(v) => setParam(CLASS_PARAM, v)}
                  options={classes.map((c) => ({
                    value: c.pilot_class,
                    label: c.pilot_class,
                  }))}
                  className="min-w-40"
                />
              ) : null}

              <SimpleSelect
                label="Pilot"
                value={subject.pilotName}
                onChange={(v) => setParam(PILOT_PARAM, v)}
                options={[...report.pilots]
                  .sort((a, b) => a.pilotName.localeCompare(b.pilotName))
                  .map((p) => ({ value: p.pilotName, label: p.pilotName }))}
                className="min-w-56"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">
                Behaviours ({selectedMetricIds.length} of {available.length})
              </span>
              <Button size="sm" variant="outline" onPress={() => setParam(METRICS_PARAM, null)}>
                Select all
              </Button>
              {FAMILY_ORDER.filter((f) => (byFamily.get(f) ?? []).length > 0).map((f) => (
                <Button
                  key={f}
                  size="sm"
                  variant="outline"
                  onPress={() =>
                    setParam(METRICS_PARAM, (byFamily.get(f) ?? []).map((m) => m.id).join(","))
                  }
                >
                  Only {FAMILY_LABELS[f].toLowerCase()}
                </Button>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FAMILY_ORDER.filter((f) => (byFamily.get(f) ?? []).length > 0).map((f) => (
                <fieldset key={f} className="flex flex-col gap-1.5">
                  <legend className="mb-1 text-sm font-medium">{FAMILY_LABELS[f]}</legend>
                  {(byFamily.get(f) ?? []).map((m) => (
                    <Checkbox
                      key={m.id}
                      isSelected={selectedSet.has(m.id)}
                      onChange={(on) => toggleMetric(m.id, on)}
                    >
                      {m.shortLabel ?? m.label}
                    </Checkbox>
                  ))}
                </fieldset>
              ))}
            </div>
          </Card>

          {nothingUsable ? (
            <Alert variant="destructive">
              <AlertTitle>No behaviours to compare on</AlertTitle>
              <AlertDescription>
                None of the selected behaviours has usable values for this field. Tick
                a different one.
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <Card aria-labelledby="results-heading" className="gap-3">
                <h2 id="results-heading" className="text-lg font-semibold">
                  Closest to {subject.pilotName}
                </h2>
                {byGap ? (
                  <p className="text-sm text-muted-foreground">
                    On a single behaviour there is no shape to compare, so these
                    pilots are ranked by how near they sat to {subject.pilotName} on
                    it — closest first.
                  </p>
                ) : null}
                <Table
                  aria-label={`Pilots ranked by behavioural similarity to ${subject.pilotName}`}
                  scrollLabel="Similarity results"
                >
                  <TableHeader>
                    <Column isRowHeader>Pilot</Column>
                    {byGap ? (
                      <>
                        <Column>Their value</Column>
                        <Column>Gap (SD)</Column>
                      </>
                    ) : (
                      <>
                        <Column>Similarity</Column>
                        <Column>Needs to beat</Column>
                        <Column>Shape only</Column>
                        <Column>Typical gap (SD)</Column>
                        <Column>Shared</Column>
                        <Column>What made them alike</Column>
                      </>
                    )}
                  </TableHeader>
                  <TableBody>
                    {shown.map((n) => (
                      <Row key={n.trackFile}>
                        <Cell>{n.pilotName}</Cell>
                        {byGap ? (
                          <>
                            <Cell className="tabular-nums">
                              {formatMetricValue(
                                n.contributions[0].unit,
                                n.contributions[0].neighbourValue
                              )}{" "}
                              {n.contributions[0].unit} ({fmtZ(n.contributions[0].neighbourZ)})
                            </Cell>
                            <Cell className="tabular-nums">{n.typicalGap.toFixed(2)}</Cell>
                          </>
                        ) : (
                          <>
                            <Cell>
                              <span className="flex items-center gap-2">
                                <span
                                  className={cn(
                                    "tabular-nums",
                                    !n.aboveNoiseFloor && "text-muted-foreground"
                                  )}
                                >
                                  {n.similarity.toFixed(3)}
                                </span>
                                <SimilarityBar
                                  value={n.similarity}
                                  muted={!n.aboveNoiseFloor}
                                />
                                {n.aboveNoiseFloor ? null : (
                                  <span className="text-xs text-muted-foreground">
                                    too little data to tell
                                  </span>
                                )}
                              </span>
                            </Cell>
                            <Cell className="tabular-nums text-muted-foreground">
                              {n.noiseFloor.toFixed(2)}
                            </Cell>
                            <Cell className="tabular-nums text-muted-foreground">
                              {n.shapeOnly.toFixed(2)}
                            </Cell>
                            <Cell className="tabular-nums">{n.typicalGap.toFixed(2)}</Cell>
                            <Cell className="tabular-nums">{n.sharedMetrics}</Cell>
                            <Cell>
                              <span className="text-xs text-muted-foreground">
                                {n.contributions
                                  .slice(0, 3)
                                  .map(
                                    (c) =>
                                      `${c.contribution >= 0 ? "+" : "−"} ${c.shortLabel ?? c.label}`
                                  )
                                  .join(", ")}
                              </span>
                            </Cell>
                          </>
                        )}
                      </Row>
                    ))}
                  </TableBody>
                </Table>
                {neighbours.length > TOP_N ? (
                  <div>
                    <Button size="sm" variant="outline" onPress={() => setShowAll((s) => !s)}>
                      {showAll
                        ? `Show the closest ${TOP_N}`
                        : `Show all ${neighbours.length} pilots`}
                    </Button>
                  </div>
                ) : null}
                {similarity && similarity.skipped.length > 0 ? (
                  <details className="text-sm text-muted-foreground">
                    <summary className="cursor-pointer">
                      {similarity.skipped.length} pilot
                      {similarity.skipped.length === 1 ? "" : "s"} could not be compared
                    </summary>
                    <ul className="mt-2 list-disc pl-5">
                      {similarity.skipped.map((s) => (
                        <li key={s.trackFile}>
                          <span className="font-medium">{s.pilotName}</span> — {s.reason}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Card>

              {shown[0] && !byGap ? (
                <Card aria-labelledby="drivers-heading" className="gap-3">
                  <h2 id="drivers-heading" className="text-lg font-semibold">
                    Why {subject.pilotName} and {shown[0].pilotName} came out closest
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    Each behaviour pushes the pair together (+) or apart (−). The
                    contributions add up to the similarity score,{" "}
                    {shown[0].similarity.toFixed(3)}.
                  </p>
                  <Table
                    aria-label={`Per-behaviour contributions for ${shown[0].pilotName}`}
                    scrollLabel="Contributions"
                  >
                    <TableHeader>
                      <Column isRowHeader>Behaviour</Column>
                      <Column>{subject.pilotName}</Column>
                      <Column>{shown[0].pilotName}</Column>
                      <Column>Contribution</Column>
                    </TableHeader>
                    <TableBody>
                      {shown[0].contributions.map((c) => (
                        <Row key={c.metricId}>
                          <Cell>{c.shortLabel ?? c.label}</Cell>
                          <Cell className="tabular-nums">
                            {formatMetricValue(c.unit, c.subjectValue)} {c.unit} (
                            {fmtZ(c.subjectZ)})
                          </Cell>
                          <Cell className="tabular-nums">
                            {formatMetricValue(c.unit, c.neighbourValue)} {c.unit} (
                            {fmtZ(c.neighbourZ)})
                          </Cell>
                          <Cell className="tabular-nums">
                            {c.contribution >= 0 ? "+" : "−"}
                            {Math.abs(c.contribution).toFixed(3)}
                          </Cell>
                        </Row>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              ) : null}
            </>
          )}

          <Card aria-labelledby="method-heading" className="gap-2">
            <h2 id="method-heading" className="text-lg font-semibold">
              How this is worked out
            </h2>
            <p className="text-sm text-muted-foreground">{similarity?.explanation}</p>
            <p className="text-sm text-muted-foreground">
              A standard deviation is how far a typical pilot sits from the field
              average on that behaviour, so "+1.4 SD" means clearly above average and
              "−0.1 SD" means all but average. Reading gaps this way keeps the size of
              a difference: two pilots who glided 0.3 km/h apart stay next to each
              other, where counting places would have separated them as much as any
              other pair.
            </p>
            {byGap ? null : (
              <>
                <p className="text-sm text-muted-foreground">
                  The "Shape only" column is what the comparison would say if it
                  looked at the direction of two pilots' departures and ignored the
                  size of them. It is shown because the two disagreeing is the
                  finding: a high shape figure beside a low similarity means these
                  pilots did the same things by very different amounts. On one task
                  in testing, the pair with the highest shape figure in the whole
                  field sat 4.6 and 0.2 standard deviations below average on the same
                  behaviour — the same direction, and nothing alike.
                </p>
                <p className="text-sm text-muted-foreground">
                  The "Typical gap" column measures the pair a third way: how far
                  apart the two sat, on average, across the behaviours you chose,
                  in standard deviations.
                </p>
                <p className="text-sm text-muted-foreground">
                  "Needs to beat" is how high two pilots who flew nothing alike
                  would score anyway, one time in twenty, simply because they were
                  compared over so few behaviours. Two pilots sharing three
                  behaviours reach 0.67 that often; two sharing twenty-two barely
                  reach 0.21. A row that does not beat its own figure is greyed and
                  marked, because there is not enough in common between those two
                  pilots to say anything — the score is real arithmetic, but it
                  carries no finding.
                </p>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
