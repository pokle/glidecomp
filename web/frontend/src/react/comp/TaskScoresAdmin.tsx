/**
 * Admin task management list — "Manage pilots & tracks". One row per pilot
 * with their outcome on the task: ranked scorers first, then a per-class
 * "did not score" tail (present-not-flown / DNF / absent).
 *
 * A LIST of rows that each open a page (issue #860): the pilot on this task
 * (pages/TaskPilotPage.tsx), which holds everything an organiser does to
 * them. A row was a card of its facts over four or five buttons, about 180px
 * tall, so 39 pilots were 7,000px of a phone, and the one way into the score
 * card that was not a button was the pilot's name, a 21px link. A row is now
 * the facts alone, two lines, and the whole row is the target.
 *
 * It was a six-column table before that (#848), which scrolled sideways on a
 * phone with the actions in the columns off-screen.
 *
 * Admin-only by design. The PUBLIC scores live in TaskScoresPublic (top 3 +
 * link to the comp scores page); this list is never server-rendered and
 * mounts only after the admin check resolves.
 */
import { useNavigate } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";
import { Card } from "@/react/rac/card";
import { GridList, GridListItem } from "@/react/rac/grid-list";
import { taskPilotPath } from "../lib/slug";
import { useCompName } from "./comp-name-context";
import { ScoreFreshness } from "./ScoreFreshness";
import { PilotFacts, useTaskPilots, type ClassRows } from "./task-pilots";

export function TaskScoresAdmin({
  compId,
  taskId,
  taskName = null,
  scoringFormat,
  timezone,
  submissionsClosed = false,
  refresh,
  onMutated,
}: {
  compId: string;
  taskId: string;
  /** Task name, for canonical pilot links. */
  taskName?: string | null;
  scoringFormat: "gap" | "open_distance";
  timezone: string | null;
  /** The organiser closed this task for submissions (migration 0028). Shown,
   * not enforced: these are the organiser tools that deliberately still work. */
  submissionsClosed?: boolean;
  /** Parent bump to refetch scores (route edits). */
  refresh: number;
  /** Notify the parent a mutation happened, so the public scores refetch too. */
  onMutated?: () => void;
}) {
  const { state, score, etag, greyed, classes } = useTaskPilots({
    compId,
    taskId,
    refresh,
    onMutated,
  });

  if (state === "loading") {
    return <p className="mt-8 text-muted-foreground">Loading pilots…</p>;
  }
  if (state === "no-route") {
    return (
      <Card>
        <h2 className="text-lg font-bold">Manage pilots &amp; tracks</h2>
        <p className="mt-2 text-muted-foreground">
          Set the route first, then you can manage pilots and tracks.
        </p>
      </Card>
    );
  }
  if (state === "unavailable" || !score) {
    return <p className="mt-8 text-muted-foreground">Pilot management not available</p>;
  }

  return (
    // A plain section, not a Card: each class's list is the card.
    <section aria-labelledby="manage-pilots-heading">
      <h2 id="manage-pilots-heading" className="text-lg font-bold">
        Manage pilots &amp; tracks
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A row opens that pilot&rsquo;s page for this task.
      </p>
      {submissionsClosed ? (
        // Otherwise an organiser who has just closed the task is left
        // wondering why their own upload still works.
        <p className="mt-1 text-sm text-muted-foreground">
          Closed for submissions. Pilots can&rsquo;t send tracks; you still can.
        </p>
      ) : null}

      <ScoreFreshness
        computedAt={score.computed_at}
        stale={greyed}
        timezone={timezone}
        etag={etag}
        pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
      />

      {classes.map((cls) => (
        <ClassList
          key={cls.pilotClass}
          cls={cls}
          compId={compId}
          taskId={taskId}
          taskName={taskName}
          showClassName={classes.length > 1}
          isOpenDistance={scoringFormat === "open_distance"}
          greyed={greyed}
        />
      ))}
    </section>
  );
}

function ClassList({
  cls,
  compId,
  taskId,
  taskName,
  showClassName,
  isOpenDistance,
  greyed,
}: {
  cls: ClassRows;
  compId: string;
  taskId: string;
  taskName: string | null;
  showClassName: boolean;
  isOpenDistance: boolean;
  greyed: boolean;
}) {
  const compName = useCompName();
  const navigate = useNavigate();
  const names = new Map(cls.rows.map((r) => [r.compPilotId, r.name]));

  return (
    <div className="mt-4">
      {showClassName ? <h3 className="mt-4 font-semibold">{cls.pilotClass}</h3> : null}
      {cls.rows.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No pilots yet</p>
      ) : (
        <GridList
          // NOT `Scores — ${class}`: the public scores already own that name,
          // and on the task page an admin has BOTH mounted at once. Two
          // lists with one accessible name is unusable with a screen reader
          // (and ambiguous to a Playwright locator).
          aria-label={`Manage pilots & tracks — ${cls.pilotClass}`}
          variant="rows"
          className="mt-2"
          // The opener marks the entry, so the pilot's page leaves with a
          // real Back and this list returns where it was left (lib/leave.ts).
          onAction={(key) =>
            navigate(
              taskPilotPath(compId, compName, taskId, taskName, String(key), names.get(String(key))))
          }
        >
          {cls.rows.map((row) => (
            <GridListItem
              key={row.compPilotId}
              variant="rows"
              id={row.compPilotId}
              textValue={row.name}
              // Under the page's bar when reached by keyboard: WCAG 2.4.11.
              className="cursor-pointer scroll-mt-24"
            >
              <PilotFacts row={row} isOpenDistance={isOpenDistance} greyed={greyed} />
              <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </GridListItem>
          ))}
        </GridList>
      )}
    </div>
  );
}
