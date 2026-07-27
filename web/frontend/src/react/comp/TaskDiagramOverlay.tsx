/**
 * The compact task glyph, made tappable: press it and the route fills the
 * screen, drawn large enough to read — turnpoint names, cylinders, the lot.
 *
 * This exists because the glyph in a task list is deliberately too small to
 * read (see TaskDiagram's `xs` preset: shape and direction only, no labels).
 * That is the right density for scanning a list of days, but it leaves an
 * obvious question — "which turnpoints is that?" — one tap away from an
 * answer, without spending a navigation to the task page to find out.
 *
 * Full-screen, following FullScreenQR (issue #312): RAC's modal primitives
 * directly rather than the kit's Modal, whose panel styling doesn't fit a
 * full-bleed overlay, so focus trapping, focus restore, Escape and body
 * scroll-locking all come from react-aria instead of hand-rolled listeners.
 * NOT rac/popover.tsx — hence the name; at full bleed there is nothing left
 * for a popover's anchoring and arrow to do.
 *
 * It departs from the QR overlay in one way, deliberately. The QR sits on a
 * black backdrop inside a white card because a QR wants maximum contrast for
 * a camera. This diagram is drawn in `currentColor` with a `var(--background)`
 * halo behind its labels, so on a black backdrop it would be near-invisible in
 * light mode and its label halos wrong in both. The sheet therefore uses the
 * app's own surface, and the diagram renders exactly as it does everywhere
 * else, in either theme.
 *
 * The trigger is a real button with a real accessible name, so this works from
 * the keyboard; the glyph inside it stays decorative, since the button's name
 * already says what it opens. SSR-safe: the overlay is not rendered until
 * opened, so the server emits only the trigger.
 */
import { useState } from "react";
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";
import type { XCTask } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { TaskDiagram, type TaskDiagramSize } from "./TaskDiagram";

export function TaskDiagramOverlay({
  task,
  taskName,
  /** Size of the glyph ON the trigger. The overlay always draws `lg`. */
  size = "xs",
}: {
  task: XCTask;
  taskName: string;
  size?: Extract<TaskDiagramSize, "xs" | "sm">;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        // h-auto + tight padding: the button is a frame around the glyph, not
        // a chrome-bearing control. Well past the 24px pointer-target floor
        // (§4.5) at every trigger size.
        className="h-auto shrink-0 p-1"
        aria-label={`Show the route for ${taskName}`}
        onPress={() => setOpen(true)}
      >
        {/* size-auto is load-bearing, not decoration: the button's base style
            is `[&_svg:not([class*='size-'])]:size-4`, which would crush the
            glyph to a 16px square. Any class containing "size-" opts out of
            that rule, and `auto` then falls back to the SVG's own
            width/height. */}
        <TaskDiagram task={task} size={size} label={null} className="size-auto" />
      </Button>

      {open ? (
        <ModalOverlay
          isOpen
          isDismissable
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
          className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm"
        >
          <AriaModal className="h-full w-full outline-none">
            <AriaDialog
              aria-label={`Route for ${taskName}`}
              className="h-full w-full outline-none"
            >
              {/* Like the QR overlay, the whole sheet is one big close target.
                  Unlike it, there is also a real Close button: a bare onClick
                  div is pointer-only, and Escape alone is not a discoverable
                  affordance (§4.1). Pressing it bubbles to the wrapper too —
                  harmless, since both do the same thing. */}
              <div
                onClick={() => setOpen(false)}
                className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-3 p-4"
              >
                <p className="text-lg font-semibold">{taskName}</p>
                {/* Sized against BOTH axes so a landscape phone doesn't push
                    the diagram off the top and bottom: the `lg` preset is
                    540×380, so capping width at 110vh keeps the height under
                    ~78vh, leaving room for the heading and the button. */}
                <div style={{ width: "min(92vw, 110vh, 1100px)" }}>
                  <TaskDiagram task={task} size="lg" className="h-auto w-full" />
                </div>
                {/* autoFocus so a keyboard user lands on the way out rather
                    than on the dialog container, which is what RAC would
                    focus otherwise. */}
                <Button
                  autoFocus
                  variant="outline"
                  size="sm"
                  onPress={() => setOpen(false)}
                >
                  Close
                </Button>
              </div>
            </AriaDialog>
          </AriaModal>
        </ModalOverlay>
      ) : null}
    </>
  );
}
