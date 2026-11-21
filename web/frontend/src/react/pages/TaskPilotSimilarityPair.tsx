/**
 * Two pilots compared, behaviour by behaviour.
 *
 * /comp/:compId/task/:taskId/analysis/similar/pair — what a row of the
 * pilot-similarity results opens. The results list has room for one figure
 * and one mark a pilot; this page holds the rest: the other figures for the
 * pair, and every behaviour with both pilots placed against the field.
 *
 * Until this page the breakdown existed for one pair only, the closest, as a
 * table under the results.
 *
 * A PAGE with its own URL, never an overlay (docs/interaction-guide.md, "No full-screen
 * overlays"). The pair and what they are compared on are in the query
 * (`?pilot=`, `?with=`, `?class=`, `?metrics=`), and the report is fetched
 * here through use-similarity.ts, so a reload and a shared link open the
 * same page. Client-only, as the results page is.
 */
import { useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Card } from "@/react/rac/card";
import { LinkButton } from "@/react/rac/button";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { READING_AXIS_INSET, ReadingRows } from "@/react/rac/reading-list";
import { formatSigned } from "@/react/rac/meter";
import { NotFound } from "../components/NotFound";
import {
  PairAxis,
  PairBehaviourRow,
  PairKey,
  formatSimilarity,
} from "../analysis/similarity-rows";
import {
  SIMILARITY_LABEL,
  SIMILARITY_WITH_PARAM,
  useSimilarity,
} from "../analysis/use-similarity";
import { underTaskAnalysis } from "../lib/crumbs";
import { taskSimilarityPath } from "../lib/slug";

export function TaskPilotSimilarityPair() {
  const { compId, taskId, searchParams, status, task, comp, report, subject, similarity } =
    useSimilarity();

  const withName = searchParams.get(SIMILARITY_WITH_PARAM);
  const other = withName
    ? (similarity?.neighbours.find((n) => n.pilotName === withName) ?? null)
    : null;

  useEffect(() => {
    if (subject && other) {
      document.title = `GlideComp - ${subject.pilotName} and ${other.pilotName}`;
    }
  }, [subject, other]);

  // Back to the results as they were: the same subject, class and behaviours.
  const resultsSearch = new URLSearchParams(searchParams);
  resultsSearch.delete(SIMILARITY_WITH_PARAM);
  const query = resultsSearch.toString();
  const resultsHref = `${taskSimilarityPath(compId, comp?.name, taskId, task?.name)}${
    query ? `?${query}` : ""
  }`;

  if (status === "notFound") return <NotFound />;

  const bar = (
    <PageBar
      title="Pilot comparison"
      trail={[
        ...underTaskAnalysis(compId, comp?.name, taskId, task?.name),
        { label: SIMILARITY_LABEL, to: resultsHref },
      ]}
    />
  );

  if (status === "loading")
    return (
      <Page width="wide" bar={bar}>
        <Loading>Loading the task analysis…</Loading>
      </Page>
    );
  if (status === "error")
    return (
      <Page width="wide" bar={bar}>
        <Alert variant="destructive">
          <AlertTitle>Could not load the analysis</AlertTitle>
          <AlertDescription>
            The task analysis could not be fetched. Reload to try again.
          </AlertDescription>
        </Alert>
      </Page>
    );

  // A report in hand and no such pair: the name is not in this class, the
  // pilot could not be compared, or the link names nobody. Say so, with the
  // way back to the list that has the pilots who can be.
  if (!report || !subject || !similarity || !other) {
    return (
      <Page width="wide" bar={bar}>
        <Card className="gap-3">
          <p className="text-sm text-muted-foreground">
            These two pilots cannot be compared on this task.
          </p>
          <div>
            <LinkButton variant="outline" href={resultsHref}>
              {SIMILARITY_LABEL}
            </LinkButton>
          </div>
        </Card>
      </Page>
    );
  }

  const byGap = similarity.ranking === "gap";
  const count = other.sharedMetrics;

  return (
    <Page width="wide" bar={bar} className="flex flex-col gap-6">
      <Card aria-labelledby="pair-heading" className="gap-3">
        <h2 id="pair-heading" className="text-lg font-semibold">
          {subject.pilotName} and {other.pilotName}
        </h2>
        <p className="text-sm text-muted-foreground">
          How alike they flew on {task?.name ?? "this task"}, on{" "}
          {count === 1 ? "the one behaviour" : `the ${count} behaviours`} they share.
        </p>
        <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-base">
          {byGap ? null : (
            <>
              <dt className="text-muted-foreground">Similarity</dt>
              <dd className="text-right font-semibold tabular-nums">
                {formatSimilarity(other.similarity)}
              </dd>
              <dt className="text-muted-foreground">Needs to beat</dt>
              <dd className="text-right tabular-nums">{other.noiseFloor.toFixed(2)}</dd>
              <dt className="text-muted-foreground">Shape only</dt>
              <dd className="text-right tabular-nums">{other.shapeOnly.toFixed(2)}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Typical gap</dt>
          <dd className="text-right tabular-nums">{other.typicalGap.toFixed(2)} SD</dd>
          <dt className="text-muted-foreground">Behaviours shared</dt>
          <dd className="text-right tabular-nums">{count}</dd>
        </dl>
        {byGap || other.aboveNoiseFloor ? null : (
          <p className="text-sm text-muted-foreground">
            The similarity is under what it needs to beat: these two have too
            little in common to tell.
          </p>
        )}
      </Card>

      <section aria-labelledby="behaviours-heading" className="flex flex-col gap-3">
        <h2 id="behaviours-heading" className="text-lg font-semibold">
          Behaviour by behaviour
        </h2>
        {byGap ? null : (
          <p className="text-sm text-muted-foreground">
            Each behaviour pushes the pair together (+) or apart (−). The
            figures add up to the similarity, {formatSimilarity(other.similarity)}.
          </p>
        )}
        <div className={READING_AXIS_INSET}>
          <PairKey subjectName={subject.pilotName} otherName={other.pilotName} className="mb-2" />
          <PairAxis />
        </div>
        <ReadingRows aria-label={`Each behaviour, for ${subject.pilotName} and ${other.pilotName}`}>
          {other.contributions.map((c) => (
            <PairBehaviourRow
              key={c.metricId}
              contribution={c}
              subjectName={subject.pilotName}
              otherName={other.pilotName}
              figure={
                byGap
                  ? `${Math.abs(c.subjectZ - c.neighbourZ).toFixed(2)} SD`
                  : formatSigned(c.contribution, 3)
              }
              figureLabel={byGap ? "Gap" : "Contribution"}
            />
          ))}
        </ReadingRows>
      </section>
    </Page>
  );
}
