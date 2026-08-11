/**
 * Task debrief — the day's anomalies against the comp's own evidence.
 *
 * Fetches the comp-level aggregate and calls out metrics that were
 * informative on THIS task but ran against a consistent consensus formed by
 * the comp's OTHER tasks (see debrief.ts for the deliberately narrow
 * definition of "interesting"). Renders nothing at all when no finding
 * qualifies, when the comp has too few tasks, or while loading — a debrief
 * that only speaks when it has evidence.
 */
import { Card } from "@/react/rac/card";
import { Explain } from "@/react/rac/explain";
import { useEffect, useState } from "react";
import { debriefFindings, debriefSentence, type DebriefFinding } from "./debrief";
import type { CompFieldAnalysisData } from "./types";

export function TaskDebrief({
  compId,
  taskId,
  pilotClass,
  onRenderedChange,
}: {
  compId: string;
  taskId: string;
  pilotClass: string;
  /**
   * Whether this section ended up on the page. It decides that itself, from
   * data it fetches itself, so the page's table of contents has no other way
   * to know — and a TOC entry whose target does not exist scrolls nowhere.
   */
  onRenderedChange?: (rendered: boolean) => void;
}) {
  const [findings, setFindings] = useState<DebriefFinding[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFindings(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/comp/${encodeURIComponent(compId)}/field-analysis`,
          { credentials: "include" },
        );
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as CompFieldAnalysisData;
        const label = body.tasks.find((t) => t.task_id === taskId)?.label;
        const aggregate = body.classes.find(
          (c) => c.pilot_class === pilotClass,
        )?.aggregate;
        const idx =
          label !== undefined && aggregate ? aggregate.taskLabels.indexOf(label) : -1;
        if (!cancelled) {
          setFindings(idx >= 0 && aggregate ? debriefFindings(aggregate, idx) : []);
        }
      } catch {
        // Best-effort garnish: a failed fetch just means no debrief.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, pilotClass]);

  const rendered = !!findings && findings.length > 0;
  useEffect(() => {
    onRenderedChange?.(rendered);
  }, [rendered, onRenderedChange]);

  if (!rendered) return null;

  return (
    <Card aria-labelledby="debrief-heading" className="gap-3">
      <h2
        id="debrief-heading"
        className="flex items-center gap-1 scroll-mt-20 text-lg font-semibold"
      >
        Task debrief
        {/* What qualifies a behaviour for this list is method — behind the ⓘ,
            and printed in place below so paper still carries it. */}
        <Explain label="What makes this list">
          <DebriefNote />
        </Explain>
      </h2>
      <p className="text-sm text-muted-foreground">
        Where this task differed from the rest of the competition.
      </p>
      <div className="hidden text-sm text-muted-foreground print:block">
        <DebriefNote />
      </div>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        {findings.map((f) => (
          <li key={f.metricId}>{debriefSentence(f)}</li>
        ))}
      </ul>
    </Card>
  );
}

/** What qualifies a behaviour for the debrief, and why a reversal is a finding
 * rather than a fault. One definition, rendered in the ⓘ and again for print. */
function DebriefNote() {
  return (
    <>
      <p>
        Each of these behaviours cleared its noise floor today, AND contradicts
        a direction that every other informative task agreed on.
      </p>
      <p>
        A day that reverses a direction is a finding about the day, and not a
        fault in the data.
      </p>
    </>
  );
}
