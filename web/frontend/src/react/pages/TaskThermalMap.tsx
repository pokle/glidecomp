/**
 * One thermal's rose over the terrain it worked, at the size of the screen —
 * /comp/:compId/task/:taskId/analysis/thermals/map?thermal=<id> (#816).
 *
 * It was a FullScreenSheet over the thermals section until 2026-11, and is a
 * page for the reason every overlay became one (docs/interaction-guide.md, "No full-screen
 * overlays"): Back, reload, scroll and focus come from the browser. So what the
 * sheet was handed in memory comes from the URL instead — which thermal
 * (`?thermal=`), whether the satellite backdrop is on (`?map=0` turns it off),
 * and the report's own view state (`?class=`, `?pilot=`) — and the report
 * itself comes through use-task-report.ts and TaskAnalysisFrame, like every
 * other page of the task analysis.
 *
 * NOT server-rendered: functions/comp/[[path]].ts serves it a noindex shell,
 * as it does the pilot-similarity tool beside it. The page exists to show the
 * map, which is browser-only (mapbox-gl stays behind `lazy()`), and everything
 * a reader or a crawler can read about the thermal — the rose, the readouts,
 * the band table — is already on the server-rendered thermals section, which
 * stays the one indexed page for it.
 *
 * Leaving: the bar's Back goes the way the reader came (#863; the map's own
 * restore control went, because it did the same thing). Arrived by the
 * section's maximise link (which marks the entry it pushes), that is a real
 * Back, so the section returns as it was left, scroll included
 * (lib/scroll-restoration.ts). Arrived any other way — a shared link — it
 * replaces this entry with the section instead, so Back from there does not
 * land on the map again.
 *
 * A `fill` page: the map has the screen under the bar to itself, and the page
 * does not scroll, so every drag belongs to the map.
 */
import { useSearchParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { TaskAnalysisFrame } from "../analysis/TaskAnalysisFrame";
import { useTaskAnalysis } from "../analysis/use-task-report";
import { findTaskAnalysisSection } from "../analysis/sections";
import {
  NoThermalsNote,
  ThermalMapView,
  shownThermal,
} from "../analysis/thermals/ThermalsPanel";
import { compUrlId, taskThermalMapPath } from "../lib/slug";
import { formatTimeOfDay } from "../lib/time";
import { useCanonicalPath } from "../lib/use-canonical-path";

export function TaskThermalMap() {
  const bundle = useTaskAnalysis();
  const { compId, taskId, comp, task, report, weather } = bundle;
  const [searchParams] = useSearchParams();
  // The id every link carries: a hidden comp's share key rides along.
  const urlId = compUrlId(comp, compId);
  const thermalsSection = findTaskAnalysisSection("thermals")!;

  useCanonicalPath(
    comp && task ? taskThermalMapPath(urlId, comp.name, taskId, task.name) : null
  );

  const shapes = report?.thermals?.shapes ?? [];
  const selected =
    shapes.length > 0 ? shownThermal(searchParams.get("thermal"), shapes) : null;

  // The section as the reader would have left it: this thermal chosen, the
  // backdrop as it is here (on, unless turned off), the class and pin kept.
  const sectionQuery = new URLSearchParams(searchParams);
  if (selected) sectionQuery.set("thermal", String(selected.id));
  if (searchParams.get("map") === "0") sectionQuery.delete("map");
  else sectionQuery.set("map", "1");
  const time = selected
    ? formatTimeOfDay(new Date(selected.startMs).toISOString(), comp?.timezone ?? undefined)
    : null;

  return (
    <TaskAnalysisFrame
      bundle={bundle}
      // The heading the sheet wore, once the thermal is known.
      section={{
        label: time ? `Thermal at ${time}` : "Thermal",
        lede: selected
          ? `${selected.pilotCount} pilots, ${selected.useCount} climbs`
          : "",
      }}
      parent={{
        slug: thermalsSection.slug,
        label: thermalsSection.label,
        search: sectionQuery.toString(),
      }}
      fill
    >
      {({ report }) =>
        report.thermals && report.thermals.shapes.length > 0 ? (
          <ThermalMapView
            thermals={report.thermals}
            weather={weather.data?.weather ?? null}
          />
        ) : (
          <Card>
            <NoThermalsNote />
          </Card>
        )
      }
    </TaskAnalysisFrame>
  );
}
