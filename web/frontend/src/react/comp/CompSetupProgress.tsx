/**
 * Competition setup guide (docs/2026-07-12-comp-setup-progress-plan.md): an
 * admin-only checklist card near the top of /comp/:id showing the five setup
 * steps, each linked to the surface where it's done. Condition-based, not
 * stored — every signal comes from the already-fetched comp payload, and the
 * card disappears on the refresh after the last step completes. "Hide guide"
 * sets a per-comp localStorage key (client-only state for a client-only
 * component: the guide renders only when isAdmin, which is false during SSR
 * and the first client paint, so it never appears in server markup).
 */
import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Circle } from "lucide-react";
import { Card, CardContent } from "@/react/ui/card";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/react/ui/progress";
import { Button } from "@/react/ui/button";
import type { CompDetailData } from "./types";

export interface SetupStep {
  key: "create" | "settings" | "waypoints" | "pilots" | "task";
  label: string;
  complete: boolean;
  /**
   * A nice-to-have step that doesn't gate completion — it still shows in the
   * checklist, but the guide's progress count and its auto-hide ignore it.
   * "Review settings" is optional because a new comp already starts from the
   * official CIVL GAP defaults for its category (issue #343).
   */
  optional?: boolean;
  /** Step-5 variant: a task exists but has no route — deep-link its editor. */
  routeTaskId?: string;
}

/**
 * Pure step derivation so completion logic unit-tests without rendering.
 * Steps can be done out of order; the checklist only reflects state.
 */
export function deriveSetupSteps(comp: CompDetailData): SetupStep[] {
  // Step 5 needs a task *with a route* — a shell task can't be flown or
  // scored. While one exists route-less, the step adapts to point at it.
  const routedTask = comp.tasks.some((t) => t.has_xctsk);
  const routelessTask = comp.tasks.find((t) => !t.has_xctsk);
  const taskStep: SetupStep =
    !routedTask && routelessTask
      ? {
          key: "task",
          label: `Set the route for ${routelessTask.name}`,
          complete: false,
          routeTaskId: routelessTask.task_id,
        }
      : { key: "task", label: "Create the first task", complete: routedTask };

  return [
    // Shown pre-checked rather than omitted: the list reads as the complete
    // recipe, and "1 of 5" is honest momentum right after creation.
    { key: "create", label: "Create the competition", complete: true },
    {
      key: "settings",
      label: "Review settings",
      complete: comp.settings_reviewed,
      optional: true,
    },
    { key: "waypoints", label: "Add waypoints", complete: comp.waypoint_count > 0 },
    { key: "pilots", label: "Add pilots", complete: comp.pilot_count > 0 },
    taskStep,
  ];
}

function hideKey(compId: string): string {
  return `glidecomp:setup-guide-hidden:${compId}`;
}

function readHidden(compId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(hideKey(compId)) === "1";
  } catch {
    return false;
  }
}

export function CompSetupProgress({
  compId,
  comp,
  onOpenSettings,
  onCreateTask,
}: {
  compId: string;
  comp: CompDetailData;
  onOpenSettings: () => void;
  onCreateTask: () => void;
}) {
  const headingId = useId();
  const [hidden, setHidden] = useState(() => readHidden(compId));

  const steps = deriveSetupSteps(comp);
  // Progress and auto-hide track the *required* steps only; optional steps
  // (e.g. "Review settings") still render but never keep the guide open.
  const requiredSteps = steps.filter((s) => !s.optional);
  const done = requiredSteps.filter((s) => s.complete).length;
  if (hidden || done === requiredSteps.length) return null;

  const next =
    steps.find((s) => !s.complete && !s.optional) ?? steps.find((s) => !s.complete);

  function hide() {
    try {
      window.localStorage.setItem(hideKey(compId), "1");
    } catch {
      // Private mode etc. — the guide still hides for this visit.
    }
    setHidden(true);
    // Keep keyboard focus somewhere sensible once the card unmounts.
    document
      .querySelector<HTMLElement>('nav[aria-label="Sections"] a')
      ?.focus();
  }

  /** The row's control: takes the admin to where the step is done. */
  function stepControl(step: SetupStep) {
    const isNext = step === next;
    const linkClass = isNext
      ? "font-medium underline underline-offset-4 hover:text-foreground"
      : "underline-offset-4 hover:underline";
    switch (step.key) {
      case "create":
        return <span>{step.label}</span>;
      case "settings":
        return (
          <button type="button" className={linkClass} onClick={onOpenSettings}>
            {step.label}
          </button>
        );
      case "waypoints":
        return (
          <Link className={linkClass} to={`/comp/${compId}/waypoints`}>
            {step.label}
          </Link>
        );
      case "pilots":
        // #edit-pilots opens PilotsSection's edit dialog (same hash pattern
        // as the task page's #edit-route deep link).
        return (
          <Link className={linkClass} to={{ hash: "#edit-pilots" }} replace>
            {step.label}
          </Link>
        );
      case "task":
        return step.routeTaskId ? (
          <Link
            className={linkClass}
            to={`/comp/${compId}/task/${step.routeTaskId}#edit-route`}
          >
            {step.label}
          </Link>
        ) : (
          <button type="button" className={linkClass} onClick={onCreateTask}>
            {step.label}
          </button>
        );
    }
  }

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <Card>
        <CardContent>
          <Progress value={Math.round((done / requiredSteps.length) * 100)}>
            <ProgressLabel
              id={headingId}
              render={<h2 />}
              className="text-base font-bold"
            >
              Set up your competition
            </ProgressLabel>
            <ProgressValue className="ml-auto">
              {() => `${done} of ${requiredSteps.length} steps`}
            </ProgressValue>
          </Progress>
          <ol className="mt-3 space-y-1.5 text-sm">
            {steps.map((step) => (
              <li key={step.key} className="flex items-center gap-2">
                {step.complete ? (
                  <Check aria-hidden className="size-4 shrink-0 text-primary" />
                ) : (
                  <Circle
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                )}
                <span className={step.complete ? "text-muted-foreground" : ""}>
                  {step.complete ? (
                    <span className="sr-only">Completed: </span>
                  ) : null}
                  {stepControl(step)}
                  {step.optional ? (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      (optional)
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-3 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={hide}>
              Hide guide
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
