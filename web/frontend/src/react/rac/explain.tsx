/**
 * The ⓘ affordance: a ghost icon button that opens a paragraph or two of
 * explanation in a popover.
 *
 * The reading flow should carry the finding; the method belongs one click
 * away, on the heading or the column header that raises the question. This is
 * the one trigger for that everywhere in the app — the task-analysis pages
 * met it first (48 instances a page, as `MetricExplanation`, which now sits on
 * top of this), and the scores and settings surfaces use the same shape so a
 * reader only ever learns one vocabulary.
 *
 * A Popover rather than a Tooltip, always: a tooltip is hover-triggered, so a
 * touch user never sees it, it dismisses on the slightest pointer move, and it
 * is not meant to hold prose. See rac/popover.tsx.
 *
 * In print the trigger is hidden — a popover cannot exist on paper. Anything
 * moved behind one MUST also be readable somewhere else: the comp report
 * carries a print-only twin under its table, and the task report states the
 * lot on its "How this was measured" page. `footnoteHref` links the two
 * together.
 */
import { InfoIcon } from "lucide-react";
import { Popover, PopoverTrigger } from "./popover";
import { Button } from "./button";
import { cn } from "@/react/lib/utils";

export function Explain({
  label,
  ariaLabel,
  sublabel,
  children,
  footnoteHref,
  footnoteLabel = "Read the full note",
  className,
}: {
  /** What is being explained — the popover's title, and the trigger's
   * accessible name as "About <label>" unless `ariaLabel` overrides it. */
  label: string;
  /** Override the trigger's accessible name where "About …" reads badly. */
  ariaLabel?: string;
  /** A tight subtitle under the label, before the prose — units, a direction,
   * a threshold. Kept out of `children` so it hugs the title. */
  sublabel?: React.ReactNode;
  children: React.ReactNode;
  /** Hash link to the static print/reference copy of this prose. */
  footnoteHref?: string;
  footnoteLabel?: string;
  className?: string;
}) {
  return (
    <PopoverTrigger>
      <Button
        variant="ghost"
        size="icon"
        // size-6 (24px), the accessibility standard's §4.5 pointer-target
        // floor (WCAG 2.5.8) — these sit crowded inside sortable column
        // headers, so they get no spacing exemption. `touch-target` adds the
        // 44px mobile hit area on a coarse pointer WITHOUT painting anything
        // bigger (issue #641): growing the button instead would re-flow the
        // header rows it sits inline in.
        className={cn(
          "touch-target size-6 text-muted-foreground print:hidden",
          className
        )}
        // A real accessible name, not a title attribute — the icon alone is
        // not a label, and title tooltips are unavailable to keyboard users.
        aria-label={ariaLabel ?? `About ${label}`}
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </Button>
      <Popover>
        {({ close }) => (
          <>
            <p className="font-medium">{label}</p>
            {sublabel ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
            ) : null}
            <div className="mt-2 space-y-2">{children}</div>
            {footnoteHref ? (
              // A plain hash link: the browser scrolls (honouring the target's
              // scroll-margin) and the hash lands in the URL, so the spot is
              // shareable. Closing first keeps the popover from floating over
              // the note after the jump.
              <a
                href={footnoteHref}
                onClick={() => close()}
                className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {footnoteLabel}
              </a>
            ) : null}
          </>
        )}
      </Popover>
    </PopoverTrigger>
  );
}
