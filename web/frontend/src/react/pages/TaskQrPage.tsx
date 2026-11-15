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
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { idFromSegment, taskQrPath } from "../lib/slug";
import { useTaskPage } from "../lib/use-task-page";

const TITLE = "QR code";

export function TaskQrPage() {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");

  const { comp, task, urlId, notFound } = useTaskPage({
    compId,
    taskId,
    title: (t) => `GlideComp - ${t.name} QR code`,
    path: taskQrPath,
  });

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

  if (notFound) return <NotFound title="Task not found" />;

  // A read page with nothing to do on it: Back, the title, and no ⋯ (#863).
  // The bar is there before the task is, so the page does not jump.
  const bar = (
    <PageBar title={TITLE} trail={underTask(urlId, comp?.name, taskId, task?.name)} />
  );
  if (!comp || !task) {
    return (
      <Page bar={bar}>
        <Loading>Loading…</Loading>
      </Page>
    );
  }

  const tooBig =
    payload !== null && new TextEncoder().encode(payload).length > XCTSK_QR_MAX_BYTES;

  return (
    <Page bar={bar} className="flex flex-col gap-4">
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
    </Page>
  );
}
