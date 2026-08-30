/**
 * TaskDebrief decides for itself whether it has anything to say — it fetches
 * the comp aggregate and renders nothing when no metric qualifies. The page's
 * table of contents has no other way to know, and a TOC entry whose target
 * does not exist scrolls nowhere, so the `onRenderedChange` contract is what
 * keeps "Task debrief" out of the TOC on the tasks that don't have one.
 *
 * Worth a test because the failure is invisible in the common case: most
 * tasks produce no debrief, so a callback that never fired would look
 * perfectly correct until the one task that has one silently lost its entry.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskDebrief } from "./TaskDebrief";

/**
 * A comp aggregate whose task 0 either flips against the other tasks or
 * agrees with them. Shaped to debriefFindings' actual rule: today must clear
 * its own noise floor, and >= 2 informative OTHER tasks must agree on the
 * opposite sign.
 */
function aggregateBody(flip: boolean) {
  const c = (rho: number) => ({ rho, absRho: Math.abs(rho), n: 30, noiseFloor: 0.36 });
  const perTaskCorrelation = [
    c(flip ? 0.8 : -0.8), // today
    c(-0.75),
    c(-0.78),
    c(-0.8),
  ];
  return {
    tasks: [{ task_id: "t1", label: "Task 1" }],
    classes: [
      {
        pilot_class: "open",
        aggregate: {
          taskLabels: ["Task 1", "Task 2", "Task 3", "Task 4"],
          metrics: [
            {
              id: "glide.speed",
              label: "Glide speed",
              unit: "km/h",
              family: "gliding",
              direction: "higher",
              perTaskCorrelation,
            },
          ],
        },
      },
    ],
  };
}

async function renderAndCollect(body: unknown): Promise<boolean[]> {
  const seen: boolean[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response)
  );
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(TaskDebrief, {
        compId: "c1",
        taskId: "t1",
        pilotClass: "open",
        onRenderedChange: (r: boolean) => seen.push(r),
      })
    );
  });
  // Let the fetch promise chain settle and re-render.
  await act(async () => {
    await Promise.resolve();
  });
  root.unmount();
  host.remove();
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskDebrief onRenderedChange", () => {
  it("reports false while it has nothing to show", async () => {
    const seen = await renderAndCollect(aggregateBody(false));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(false);
    expect(document.getElementById("debrief-heading")).toBeNull();
  });

  it("reports true once a finding qualifies, so the TOC can list it", async () => {
    const seen = await renderAndCollect(aggregateBody(true));
    expect(seen.at(-1)).toBe(true);
  });
});
