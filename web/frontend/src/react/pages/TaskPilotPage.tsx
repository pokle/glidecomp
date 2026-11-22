/**
 * One pilot on one task, for the organiser.
 *
 * /comp/:compId/task/:taskId/pilot/:pilotId/manage — what a row of the task
 * page's "Manage pilots & tracks" opens (issue #860). Everything an organiser
 * does to a pilot on a task is here: their status, uploading or replacing
 * their track, recording a manual flight, restoring a superseded track, and
 * the way to their score card. The list had all of it as buttons in every
 * row, which made each row 180px of a phone.
 *
 * Its actions are ON the page, not in the bar's ⋯: they are what the page is
 * for (docs/interaction-guide.md, "The page is for information, and every action goes in the
 * bar", and its exception for a page whose content IS its actions).
 *
 * A PAGE with its own URL, never an overlay. The pilot is named by the URL
 * and everything is fetched here (comp/task-pilots.tsx), so a reload and a
 * shared link open the same page. Admin-only and never server-rendered;
 * anyone else is sent to the task page (components/OrganisersOnly.tsx).
 */
import { useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { OrganisersOnly } from "@/react/components/OrganisersOnly";
import { Card } from "@/react/rac/card";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { NavActionRow, NavFileRow, NavList, NavRow } from "@/react/rac/nav-list";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { api } from "../../comp/api";
import { CompNameProvider } from "../comp/comp-name-context";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import {
  NOT_AN_IGC_MESSAGE,
  UNREADABLE_FILE_MESSAGE,
  describeUploadOutcome,
  tooLargeReason,
  type TrackQualityWire,
} from "../comp/submit-track";
import { PilotFacts, useTaskPilots, type RowPilot } from "../comp/task-pilots";
import {
  compressIgc,
  isPastCloseDate,
  type CompDetailData,
  type PilotStatusEntry,
  type TaskDetailData,
} from "../comp/types";
import { underTask } from "../lib/crumbs";
import {
  compUrlId,
  idFromSegment,
  manualFlightPath,
  pilotPath,
  taskPath,
  taskPilotPath,
} from "../lib/slug";
import { toast } from "../lib/toast";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { useAdminView, useUser } from "../lib/user";

export function TaskPilotPage() {
  const {
    compId: compParam,
    taskId: taskParam,
    pilotId: pilotParam,
  } = useParams<{ compId: string; taskId: string; pilotId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const compPilotId = idFromSegment(pilotParam ?? "");
  const { loading } = useUser();

  const { data: comp, notFound: compNotFound, current: compCurrent } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    });
  const { data: task, notFound: taskNotFound, current: taskCurrent } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({ param: { comp_id, task_id } }),
    });

  const pilots = useTaskPilots({ compId, taskId });
  const row =
    pilots.classes.flatMap((c) => c.rows).find((r) => r.compPilotId === compPilotId) ?? null;

  useCanonicalPath(
    comp && task && row && compCurrent && taskCurrent
      ? taskPilotPath(compUrlId(comp, compId), comp.name, taskId, task.name, compPilotId, row.name)
      : null
  );

  const isAdmin = useAdminView(!!comp?.is_admin);

  if (compNotFound || taskNotFound || !compId || !taskId || !compPilotId) {
    return <NotFound title="Task not found" />;
  }

  const bar = (
    <PageBar
      title={row?.name ?? "Pilot"}
      trail={underTask(compId, comp?.name, taskId, task?.name)}
    />
  );

  if (!comp || !task || loading || pilots.state === "loading") {
    return (
      <Page bar={bar}>
        <Loading>Loading…</Loading>
      </Page>
    );
  }

  const taskHref = taskPath(compUrlId(comp, compId), comp.name, taskId, task.name);
  if (!isAdmin) return <OrganisersOnly to={taskHref} />;

  if (pilots.state === "no-route") {
    return (
      <Page bar={bar}>
        <p className="text-muted-foreground">
          Set the route first, then you can manage pilots and tracks.
        </p>
      </Page>
    );
  }
  if (pilots.state !== "ok" || !pilots.score) {
    return (
      <Page bar={bar}>
        <p className="text-muted-foreground">Pilot management not available</p>
      </Page>
    );
  }
  // The scores are in hand and name no such pilot in this task's classes.
  if (!row) return <NotFound title="Pilot not found" />;

  const isOpenDistance = comp.scoring_format === "open_distance";

  return (
    <Page bar={bar} className="flex flex-col gap-6">
      <Card className="gap-2">
        <PilotFacts row={row} isOpenDistance={isOpenDistance} greyed={pilots.greyed} />
        {/* The consequence of everything below: the one thing the controls
            themselves do not say. */}
        <p className="text-sm text-muted-foreground">
          Every change here recomputes the task&rsquo;s scores.
        </p>
        <ScoreFreshness
          computedAt={pilots.score.computed_at}
          stale={pilots.greyed}
          timezone={comp.timezone ?? null}
          etag={pilots.etag}
          pollUrl={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/score`}
        />
      </Card>

      <CompNameProvider value={comp.name}>
        <PilotActions
          row={row}
          compId={compId}
          compName={comp.name}
          taskId={taskId}
          taskName={task.name}
          isClosed={isPastCloseDate(comp.close_date ?? null)}
          hasRoute={!!task.xctsk && task.xctsk.turnpoints.length > 0}
          statuses={pilots.statuses}
          onMutated={pilots.afterMutation}
        />
      </CompNameProvider>
    </Page>
  );
}

/**
 * What an organiser does to the pilot: set their status, upload or replace
 * their track, record a manual flight, restore superseded evidence, and read
 * their score card.
 */
function PilotActions({
  row,
  compId,
  compName,
  taskId,
  taskName,
  isClosed,
  hasRoute,
  statuses,
  onMutated,
}: {
  row: RowPilot;
  compId: string;
  compName: string;
  taskId: string;
  taskName: string;
  /** Past the competition's close date: nothing here changes any more. */
  isClosed: boolean;
  /** A manual flight needs a route to measure against. */
  hasRoute: boolean;
  statuses: Map<string, PilotStatusEntry>;
  onMutated: () => void;
}) {
  // Every action on the page shares one: one press at a time, and a refusal
  // shown beside the controls — where the organiser just pressed — not in a
  // toast that is gone before it is read (rac/form.tsx, `useAction`).
  const action = useAction();
  const busy = action.pending;

  async function uploadTrackFile(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".igc")) {
      action.refuse(NOT_AN_IGC_MESSAGE);
      return;
    }
    let compressed: ArrayBuffer;
    try {
      compressed = await compressIgc(file);
    } catch {
      // Nothing was sent: the file could not be read, which is not a
      // dropped connection.
      action.refuse(UNREADABLE_FILE_MESSAGE);
      return;
    }
    // The size rule is the server's, both halves of it.
    const tooLarge = tooLargeReason(file.size, compressed.byteLength);
    if (tooLarge) {
      action.refuse(tooLarge);
      return;
    }
    const res = await action.run(
      () =>
        fetch(
          `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}`,
          { method: "POST", credentials: "include", body: compressed }
        ),
      { key: "upload" }
    );
    if (!res) return;
    const data = (await res.json().catch(() => ({}))) as {
      replaced?: boolean;
      track_quality?: TrackQualityWire | null;
    };
    // A withheld track must not be announced as a plain success — the pilot
    // it belongs to is not here to notice, so the admin is the only one who
    // can act on it. The upload itself succeeded, so this stays a toast.
    const outcome = describeUploadOutcome(row.name, !!data.replaced, data.track_quality);
    toast[outcome.tone](outcome.message);
    onMutated();
  }

  // The status the admin controls directly: Present (clear) / Absent / DNF.
  // Landed is derived from evidence and never hand-set. A refused change
  // leaves the select showing the stored status, with the reason beneath.
  const statusKey = statuses.get(row.compPilotId)?.status_key ?? "";
  const statusValue = statusKey === "absent" || statusKey === "dnf" ? statusKey : "";

  async function setStatus(next: string) {
    const param = { comp_id: compId, task_id: taskId, comp_pilot_id: row.compPilotId };
    const endpoint =
      api.api.comp[":comp_id"].task[":task_id"]["pilot-status"][":comp_pilot_id"];
    const res = await action.run(() =>
      next === ""
        ? endpoint.$delete({ param })
        : endpoint.$put({
            param,
            json: { status_key: next as "absent" | "dnf", note: null },
          })
    );
    if (res) onMutated();
  }

  async function restoreTrack() {
    const res = await action.run(
      () =>
        fetch(
          `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(row.compPilotId)}/restore`,
          { method: "POST", credentials: "include" }
        ),
      { key: "restore" }
    );
    if (res) onMutated();
  }

  const canRestore = row.supersededTrack && row.evidence !== "track" && !isClosed;
  const scored = row.outcome === "landed" && !!row.score;

  return (
    <>
      <section aria-labelledby="pilot-status-heading">
        <h2 id="pilot-status-heading" className="mb-2 text-sm font-medium text-muted-foreground">
          Status
        </h2>
        <SimpleSelect
          value={statusValue}
          onChange={(v) => void setStatus(v)}
          options={[
            { value: "", label: "Present" },
            { value: "absent", label: "Absent" },
            { value: "dnf", label: "Did Not Fly" },
          ]}
          disabled={busy || isClosed}
          // Names the pilot: the heading above says only "Status".
          ariaLabel={`Status for ${row.name}`}
          className="w-full"
          triggerClassName="h-11 text-base"
        />
        <p className="mt-2 text-sm text-muted-foreground">
          Absent and Did Not Fly count towards the task&rsquo;s launch validity.
        </p>
      </section>

      {/* Under the status and above the lists: where a refusal of any of them
          is read. */}
      <ActionErrorBanner action={action} />

      {isClosed ? null : (
        <NavList label="Track" labelAs="h2">
          <NavFileRow
            acceptedFileTypes={[".igc"]}
            onSelect={(files) => void uploadTrackFile(files)}
            label={row.evidence === "track" ? "Replace track" : "Upload track"}
            description="The pilot's GPS track, an IGC file"
            // Busy while its own upload is in flight; another action in
            // flight leaves it unavailable meanwhile.
            isPending={action.pendingKey === "upload"}
            pendingLabel={`Uploading ${row.name}'s track`}
            isDisabled={busy && action.pendingKey !== "upload"}
          />
          {hasRoute ? (
            // A link: recording a manual flight is a page of its own (#637).
            <NavRow
              to={manualFlightPath(compId, compName, taskId, taskName, row.compPilotId, row.name)}
              label={row.evidence === "manual" ? "Edit manual flight" : "Add manual flight"}
              description="For a pilot with no tracklog"
            />
          ) : null}
          {canRestore ? (
            <NavActionRow
              onPress={() => void restoreTrack()}
              label="Restore track"
              description="Restore this pilot's superseded track"
              isPending={action.pendingKey === "restore"}
              pendingLabel={`Restoring ${row.name}'s track`}
              isDisabled={busy && action.pendingKey !== "restore"}
            />
          ) : null}
        </NavList>
      )}

      {scored ? (
        <NavList>
          <NavRow
            to={pilotPath(compId, compName, taskId, taskName, row.compPilotId, row.name)}
            label="Score card"
            description="How the points were worked out"
          />
        </NavList>
      ) : null}
    </>
  );
}
