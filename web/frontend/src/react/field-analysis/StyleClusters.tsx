/**
 * Pilot style clusters — who flew alike, annotated with how each group fared.
 *
 * The engine's clusterPilotStyles groups pilots by flying BEHAVIOUR (never on
 * outcome metrics), so a group's rank spread is the finding the correlation
 * tables can't show: "this group climbs in the top quartile but gives it back
 * on glide". Computed at render time from the stored report — nothing new is
 * stored, and the CLI derives the identical grouping from the same function.
 *
 * Percentiles and group membership are invariant under the display-unit
 * conversion (a positive linear scale preserves ranks), so this receives the
 * display report and signature medians read in the viewer's units.
 *
 * Accessibility: the member lists ARE the content (names and ranks as text);
 * hovering a member lights that pilot up page-wide via PilotHighlightContext,
 * a visual nicety layered on top, same pattern as the percentile heatmap.
 */
import { useMemo } from "react";
import { cn } from "@/react/lib/utils";
import { usePilotHighlight } from "./PilotHighlightContext";
import { unitWords } from "./units";
import {
  clusterPilotStyles,
  formatMetricValue,
  MIN_CLUSTER_PILOTS,
  type FieldAnalysisReport,
  type StyleCluster,
} from "./types";

/** Whole ranks stay whole; an even-count median shows its half. */
function fmtRank(r: number): string {
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function ClusterCard({ cluster }: { cluster: StyleCluster }) {
  const { highlight, setHighlight } = usePilotHighlight();
  const headingId = `style-cluster-${cluster.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className="space-y-3 rounded-lg border p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 id={headingId} className="font-semibold">
          Group {cluster.id} — {cluster.label}
        </h3>
        <p className="text-xs text-muted-foreground">
          {cluster.members.length} pilots · ranks {cluster.rankBest}–{cluster.rankWorst} · median{" "}
          {fmtRank(cluster.rankMedian)} · middle half {fmtRank(cluster.rankP25)}–
          {fmtRank(cluster.rankP75)}
        </p>
      </header>

      <ul className="space-y-1 text-sm">
        {cluster.signatures.length === 0 ? (
          <li className="text-muted-foreground">
            Near field-typical on every metric — no strong signature.
          </li>
        ) : (
          cluster.signatures.map((s) => (
            <li key={s.metricId} className="flex gap-2">
              <span aria-hidden className="text-muted-foreground">
                {s.deviation > 0 ? "▲" : "▼"}
              </span>
              <span>
                <strong>
                  {s.deviation > 0 ? "High" : "Low"} — {s.label}
                </strong>{" "}
                <span className="text-muted-foreground">
                  group median P{Math.round(s.medianPercentile)} in this field (
                  {formatMetricValue(s.unit, s.medianValue)} {unitWords(s.unit)})
                  {/* The metric's direction prior, not this task's verdict —
                      hence "usually". Neutral metrics get no hint. */}
                  {s.hint === "strength"
                    ? " · usually a strength"
                    : s.hint === "cost"
                      ? " · usually costly"
                      : null}
                </span>
              </span>
            </li>
          ))
        )}
      </ul>

      <ul
        className="flex flex-wrap gap-1.5"
        onMouseLeave={() => setHighlight(null)}
      >
        {cluster.members.map((m) => {
          const exemplar = m.trackFile === cluster.exemplarTrackFile;
          return (
            <li
              key={m.trackFile}
              onMouseEnter={() => setHighlight(m.trackFile)}
              className={cn(
                "rounded-full border px-2 py-0.5 text-xs",
                highlight === m.trackFile && "bg-accent",
                exemplar && "border-foreground/40 font-medium"
              )}
            >
              <span className="tabular-nums text-muted-foreground">{m.rank}.</span>{" "}
              {m.pilotName}
              {exemplar ? (
                <>
                  <span aria-hidden> ★</span>
                  <span className="sr-only"> (most typical of this group)</span>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    </article>
  );
}

export function StyleClusters({ report }: { report: FieldAnalysisReport }) {
  const sc = useMemo(() => clusterPilotStyles(report), [report]);

  if (!sc) {
    return (
      <p className="text-sm text-muted-foreground">
        Fewer than {MIN_CLUSTER_PILOTS} pilots have enough metric coverage to
        compare, so no style groups are formed for this field.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Groups are flying <em>style</em>, not score — the rank spread on each
        shows where that style did and did not pay. Each group is named after
        its strongest signature; ★ marks the pilot most typical of their
        group.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {sc.clusters.map((c) => (
          <ClusterCard key={c.id} cluster={c} />
        ))}
      </div>
      {sc.unclustered.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Not clustered:{" "}
          {sc.unclustered
            .map((u) => `${u.rank}. ${u.pilotName} — ${u.reason}`)
            .join("; ")}
          .
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {sc.explanation} Here: {sc.pilotCount} pilots on {sc.metricCount}{" "}
        behavioural metrics formed {sc.k} groups (k searched {sc.kMin}–{sc.kMax});
        mean silhouette {sc.meanSilhouette.toFixed(2)} — near 0 means soft group
        boundaries, near 1 tight well-separated groups.
      </p>
    </div>
  );
}
