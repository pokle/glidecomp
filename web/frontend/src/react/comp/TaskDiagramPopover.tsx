/**
 * The compact task glyph, made tappable: press it and a popover shows the same
 * route drawn large enough to read — turnpoint names, cylinders, the lot.
 *
 * This exists because the glyph in a task list is deliberately too small to
 * read (see TaskDiagram's `xs` preset: shape and direction only, no labels).
 * That is the right density for scanning a list of days, but it leaves an
 * obvious question — "which turnpoints is that?" — one tap away from an
 * answer, without spending a navigation to the task page to find out.
 *
 * The trigger is a real button with a real accessible name, so this works from
 * the keyboard and reads correctly to a screen reader; the glyph inside it
 * stays decorative, since the button's name already says what it opens. The
 * large diagram in the popover carries its own text alternative (the route
 * read out in order), so nothing here is pointer-only.
 *
 * SSR-safe: RAC renders only the trigger button server-side, and the popover
 * content mounts on open — the same shape the field-analysis pages already
 * server-render with their method popovers.
 */
import type { XCTask } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { Popover, PopoverTrigger } from "@/react/rac/popover";
import { TaskDiagram, type TaskDiagramSize } from "./TaskDiagram";

export function TaskDiagramPopover({
  task,
  taskName,
  /** Size of the glyph ON the trigger. The popover always shows `md`. */
  size = "xs",
}: {
  task: XCTask;
  taskName: string;
  size?: Extract<TaskDiagramSize, "xs" | "sm">;
}) {
  return (
    <PopoverTrigger>
      <Button
        variant="ghost"
        // h-auto + tight padding: the button is a frame around the glyph, not
        // a chrome-bearing control. Well past the 24px pointer-target floor
        // (§4.5) at every trigger size.
        className="h-auto shrink-0 p-1"
        aria-label={`Show the route for ${taskName}`}
      >
        {/* size-auto is load-bearing, not decoration: the button's base style
            is `[&_svg:not([class*='size-'])]:size-4`, which would crush the
            glyph to a 16px square. Any class containing "size-" opts out of
            that rule, and `auto` then falls back to the SVG's own
            width/height. */}
        <TaskDiagram task={task} size={size} label={null} className="size-auto" />
      </Button>

      {/* Wider than the kit's default max-w-xs, which would crop the diagram,
          and capped to the viewport so a phone gets the whole thing.

          Nothing else lives in here — no "Task details" link. RAC caps a
          popover's height to the space available, and on a phone the diagram
          alone very nearly fills that; anything below it lands under an
          internal scroll, which is a poor home for an action. The task name
          beside the glyph is already a link, and the featured card already
          has a Task details button, so the link would have been a third path
          to the same page bought at the cost of the fit. */}
      <Popover className="max-w-[min(24rem,calc(100vw-1.5rem))]">
        <p className="font-medium">{taskName}</p>
        {/* w-full + h-auto: the SVG scales to whatever width the popover ends
            up with, so a narrow phone shrinks it rather than clipping it.
            Everything is in viewBox units, so the labels scale with it. */}
        <TaskDiagram task={task} size="md" className="mt-1 h-auto w-full" />
      </Popover>
    </PopoverTrigger>
  );
}
