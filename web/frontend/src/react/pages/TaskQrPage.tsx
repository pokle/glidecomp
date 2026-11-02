/**
 * The task's QR code (/comp/:compId/task/:taskId/qr) — PUBLIC, and NOT SSR'd:
 * functions/comp/[[path]].ts serves it a noindex shell.
 *
 * It was a full-screen overlay over the task page until 2026-11 (issue #813),
 * handed the encoded route in memory and dismissed with a tap. A page has its
 * own URL, so Back is the browser's and the link can be shared or reloaded; it
 * therefore fetches the task (for the route) and the competition (for the names
 * in the trail and a hidden comp's share key) itself.
 *
 * Why a shell and not a server-rendered page: everything on it is a picture
 * for a camera. A crawler gets nothing from a QR code that the task page — the
 * indexed, server-rendered one, with the same route as text — does not already
 * give it, and server-rendering would pull `qrcode.react` into the SSR bundle
 * for no reader. The page is lazy-loaded, so the library also stays out of the
 * main client bundle.
 *
 * A hidden comp's page 404s without its share key, as every other page of it
 * does: both fetches are the public read routes, which gate on
 * `hiddenFromViewer()`.
 *
 * The code is drawn on a white card whatever the theme: a camera wants dark
 * modules on light with a quiet zone round them. Its width is the column's, so
 * a phone shows it edge to edge without scrolling sideways, capped by the
 * viewport's height so the whole code fits on screen at once.
 */
import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import {
  encodeXctskQR,
  xctaskTurnpointsToRecords,
  XCTSK_QR_MAX_BYTES,
} from "@glidecomp/engine";
import { NotFound } from "@/react/components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
import type { CompDetailData, TaskDetailData } from "../comp/types";
import { underTask } from "../lib/crumbs";
import { compUrlId, idFromSegment, taskQrPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { useSeededResource } from "../lib/use-seeded-resource";

const TITLE = "QR code";

export function TaskQrPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");

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
        api.api.comp[":comp_id"].task[":task_id"].$get({
          param: { comp_id, task_id },
        }),
      title: (t) => `GlideComp - ${t.name} QR code`,
    });

  // The id every link carries: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);

  // Only from what was loaded for THIS URL — see useCanonicalPath.
  useCanonicalPath(
    comp && task && compCurrent && taskCurrent
      ? taskQrPath(urlId, comp.name, taskId, task.name)
      : null
  );

  // The same payload the results record prints (results-record/build.ts
  // `routeQr`): the turnpoints and radii as an XCTrack `XCTSK:` task.
  const xctsk = task?.xctsk ?? null;
  const turnpoints = xctsk?.turnpoints ?? [];
  const payload = useMemo(
    () =>
      xctsk && xctsk.turnpoints.length > 0
        ? encodeXctskQR(xctaskTurnpointsToRecords(xctsk.turnpoints))
        : null,
    [xctsk]
  );

  if (compNotFound || taskNotFound) return <NotFound title="Task not found" />;
  if (!comp || !task) return <Loading>Loading…</Loading>;

  const crumbs = underTask(urlId, comp.name, taskId, task.name);
  const tooBig =
    payload !== null && new TextEncoder().encode(payload).length > XCTSK_QR_MAX_BYTES;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Breadcrumbs items={crumbs} current={TITLE} />
        <h1 className="mt-2 text-2xl font-bold">{TITLE}</h1>
      </div>
      {payload === null ? (
        <p className="text-muted-foreground">No route defined for this task yet.</p>
      ) : tooBig ? (
        <p className="text-muted-foreground">
          Too many turnpoints ({turnpoints.length}) to fit in a single QR code —
          download a file instead.
        </p>
      ) : (
        <figure className="flex flex-col items-center gap-3">
          <div
            data-testid="task-qr"
            className="w-[min(100%,72svh,560px)] rounded-2xl bg-white p-4 shadow-sm ring-1 ring-border"
          >
            <QRCodeSVG
              value={payload}
              // Level L maximises capacity; scanned from a screen at close range.
              level="L"
              marginSize={2}
              size={512}
              role="img"
              aria-labelledby="task-qr-caption"
              className="block h-auto w-full"
            />
          </div>
          <figcaption
            id="task-qr-caption"
            className="max-w-md text-center text-sm text-muted-foreground"
          >
            {task.name} · scan with XCTrack, Flyskyhy or any XCTSK-aware app
          </figcaption>
        </figure>
      )}
    </div>
  );
}
