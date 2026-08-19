/**
 * Recording a manual flight for one pilot
 * (/comp/:compId/task/:taskId/pilot/:pilotId/manual-flight) — ADMIN-ONLY and
 * NOT SSR'd (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * A child of the pilot's report card because that is the page it is about, and
 * the page the recorded flight then has to explain. The form itself lives in
 * comp/ManualFlightForm.tsx, which was a dialog over the admin scores grid
 * until #637.
 *
 * Four fetches, all of them the page's own: the comp (scoring format and
 * distance origin — the preview must be computed the way the server scores),
 * the task (its route drives both the turnpoint list and the made-good
 * geometry), the roster (the pilot's name) and the task's manual flights (the
 * prefill, when this is an edit rather than a first record). They are the
 * arguments the dialog used to be handed by the grid it opened from; on its
 * own URL there is no grid to hand them over.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { underPilot } from "../lib/crumbs";
import { idFromSegment, manualFlightPath, taskPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";
import { fetchWithRetry } from "../comp/types";
import type {
  CompDetailData,
  ManualFlightEntry,
  PilotListEntry,
  TaskDetailData,
} from "../comp/types";
import { ManualFlightForm } from "../comp/ManualFlightForm";

export function ManualFlightPage() {
  const {
    compId: compParam,
    taskId: taskParam,
    pilotId: pilotParam,
  } = useParams<{ compId: string; taskId: string; pilotId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const compPilotId = idFromSegment(pilotParam ?? "");
  const navigate = useNavigate();
  const { user, loading } = useUser();

  const { data: comp, notFound: compNotFound } =
    useSeededResource<CompDetailData>({
      ids: [compId],
      seed: null,
      load: ([comp_id]) => api.api.comp[":comp_id"].$get({ param: { comp_id } }),
    });
  const { data: task, notFound: taskNotFound } =
    useSeededResource<TaskDetailData>({
      ids: [compId, taskId],
      seed: null,
      load: ([comp_id, task_id]) =>
        api.api.comp[":comp_id"].task[":task_id"].$get({
          param: { comp_id, task_id },
        }),
      title: (t) => `GlideComp - manual flight, ${t.name}`,
    });

  // The pilot's name and any flight already recorded. Both are supporting
  // detail rather than the page's identity, so they get their own effect and
  // their own "still loading" state — but they go through fetchWithRetry all
  // the same, because a dropped request must not read as "no such pilot"
  // (#481).
  const [pilot, setPilot] = useState<PilotListEntry | null>(null);
  const [existing, setExisting] = useState<ManualFlightEntry | null>(null);
  const [auxLoaded, setAuxLoaded] = useState(false);

  useEffect(() => {
    if (!compId || !taskId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [rosterRes, manualRes] = await Promise.all([
          fetchWithRetry(() =>
            api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } })
          ),
          fetchWithRetry(() =>
            api.api.comp[":comp_id"].task[":task_id"]["manual-flight"].$get({
              param: { comp_id: compId, task_id: taskId },
            })
          ),
        ]);
        if (cancelled) return;
        if (rosterRes.ok) {
          const { pilots } = (await rosterRes.json()) as {
            pilots: PilotListEntry[];
          };
          setPilot(
            (pilots ?? []).find((p) => p.comp_pilot_id === compPilotId) ?? null
          );
        }
        if (manualRes.ok) {
          const { manual_flights } = (await manualRes.json()) as {
            manual_flights: ManualFlightEntry[];
          };
          setExisting(
            (manual_flights ?? []).find(
              (m) => m.comp_pilot_id === compPilotId && m.active
            ) ?? null
          );
        }
      } catch {
        /* The form still works without a prefill or a name. */
      } finally {
        if (!cancelled) setAuxLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, compPilotId]);

  useCanonicalPath(
    comp && task && pilot
      ? manualFlightPath(
          compId,
          comp.name,
          taskId,
          task.name,
          compPilotId,
          pilot.name
        )
      : null
  );

  const isAdmin = useAdminView(
    user != null &&
      comp != null &&
      comp.admins.some((a) => a.email === user.email)
  );

  if (compNotFound || taskNotFound || !compId || !taskId || !compPilotId) {
    return <NotFound title="Task not found" />;
  }

  if (!comp || !task || !auxLoaded || loading) {
    return <Loading>Loading…</Loading>;
  }

  const crumbs = underPilot(
    compId,
    comp.name,
    taskId,
    task.name,
    compPilotId,
    pilot?.name
  );

  if (!isAdmin) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current="Record manual flight" />
        <h1 className="mt-2 text-2xl font-bold">Record manual flight</h1>
        <p className="mt-2 text-muted-foreground">
          Recording a flight for a pilot is for competition admins.
        </p>
      </div>
    );
  }

  // A manual flight is scored from the route, so without one there is nothing
  // to record against — the same condition that hid the grid's button.
  if (!task.xctsk) {
    return (
      <div>
        <Breadcrumbs items={crumbs} current="Record manual flight" />
        <h1 className="mt-2 text-2xl font-bold">Record manual flight</h1>
        <p className="mt-2 text-muted-foreground">
          This task has no route yet. A manual flight is measured along the
          course, so there is nothing to measure against until one is set.
        </p>
      </div>
    );
  }

  const backToTask = () =>
    navigate(taskPath(compId, comp.name, taskId, task.name));

  return (
    <ManualFlightForm
      compId={compId}
      compName={comp.name}
      taskId={taskId}
      taskName={task.name}
      compPilotId={compPilotId}
      pilotName={pilot?.name ?? "This pilot"}
      task={task.xctsk}
      distanceOrigin={comp.gap_params?.distanceOrigin ?? "takeoff"}
      openDistance={comp.scoring_format === "open_distance"}
      existing={existing}
      onCancel={backToTask}
      onSaved={backToTask}
    />
  );
}
