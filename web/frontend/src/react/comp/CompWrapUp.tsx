/**
 * The wrap-up card: once a competition's close date has passed, its admins
 * are prompted to keep the results record (src/results-record/) — the same
 * shape as the setup guide at the top of the comp page (CompSetupProgress),
 * because it is the same kind of thing: the next job to do, at the top of
 * the page where the organiser will see it.
 *
 * Why prompt at all: GlideComp re-scores every competition when the scoring
 * engine changes, and stores no snapshot. The PDF is the only copy of the
 * scores as they stood, and only if someone downloads it. The close date is
 * the natural moment — the results have settled.
 *
 * Condition-based, like the guide: shown to an admin after the close date of
 * a comp with at least one routed task. "Downloaded" is remembered per comp
 * in localStorage, which is per browser — another admin, or another device,
 * is still prompted, and that is fine: nobody is harmed by a second copy, and
 * a record nobody kept is the failure this exists to prevent. Once done the
 * card stays (checked) for the rest of the visit, so the link the admin just
 * pressed does not vanish from under their focus, and is gone on the next.
 *
 * Client-only: it renders only for an admin, which is false during SSR and
 * the first client paint, so it never appears in server markup.
 */
import { useId, useState } from "react";
import { Check, Circle } from "lucide-react";
import { Button } from "@/react/rac/button";
import { ProgressBar } from "@/react/rac/progress";
import { formatTaskDate, todayInZone } from "../lib/format";
import { compScoresPdfPath } from "../lib/slug";
import type { CompDetailData } from "./types";

export interface WrapUpStep {
  key: "closed" | "record";
  label: string;
  complete: boolean;
}

/** Has the comp closed? The close date is the END of that day, in the comp's
 * own zone — the same reading the submission routes take. */
export function isCompClosedForWrapUp(
  comp: Pick<CompDetailData, "close_date" | "timezone">,
  now: Date = new Date()
): boolean {
  return !!comp.close_date && todayInZone(comp.timezone ?? "UTC", now) > comp.close_date;
}

/** Pure step derivation, so it unit-tests without rendering. */
export function deriveWrapUpSteps(
  comp: Pick<CompDetailData, "close_date">,
  recordSaved: boolean
): WrapUpStep[] {
  return [
    {
      key: "closed",
      label: comp.close_date
        ? `Submissions closed on ${formatTaskDate(comp.close_date)}`
        : "Submissions closed",
      complete: true,
    },
    { key: "record", label: "Download the results record (PDF)", complete: recordSaved },
  ];
}

function storageKey(kind: "hidden" | "saved", compId: string): string {
  return `glidecomp:wrap-up-${kind}:${compId}`;
}

function readFlag(kind: "hidden" | "saved", compId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(storageKey(kind, compId)) != null;
  } catch {
    return false;
  }
}

function writeFlag(kind: "hidden" | "saved", compId: string): void {
  try {
    window.localStorage.setItem(storageKey(kind, compId), new Date().toISOString());
  } catch {
    // Private mode etc. — the card still updates for this visit.
  }
}

export function CompWrapUp({ compId, comp }: { compId: string; comp: CompDetailData }) {
  const headingId = useId();
  const [hidden, setHidden] = useState(() => readFlag("hidden", compId));
  // Read once: a record saved on an EARLIER visit hides the card; one saved
  // during this visit only checks the step.
  const [savedBefore] = useState(() => readFlag("saved", compId));
  const [savedNow, setSavedNow] = useState(false);

  if (hidden || savedBefore) return null;
  if (!isCompClosedForWrapUp(comp)) return null;
  // Nothing was ever scored: there is no record to keep.
  if (!comp.tasks.some((t) => t.has_xctsk)) return null;

  const steps = deriveWrapUpSteps(comp, savedNow);
  const done = steps.filter((s) => s.complete).length;

  function hide() {
    writeFlag("hidden", compId);
    setHidden(true);
    // Keep keyboard focus somewhere sensible once the card unmounts.
    document.querySelector<HTMLElement>('nav[aria-label="Sections"] a')?.focus();
  }

  function stepControl(step: WrapUpStep) {
    if (step.key === "closed") return <span>{step.label}</span>;
    return (
      // A plain anchor, not a router link: the PDF is a file the Pages
      // Function serves, and `download` makes the browser save it.
      <a
        href={compScoresPdfPath(compId, comp.name)}
        download=""
        className={
          step.complete
            ? "underline-offset-4 hover:underline"
            : "font-medium underline underline-offset-4 hover:text-foreground"
        }
        onClick={() => {
          writeFlag("saved", compId);
          setSavedNow(true);
        }}
      >
        {step.label}
      </a>
    );
  }

  return (
    <section aria-labelledby={headingId} className="mt-6">
      <div className="rounded-xl bg-card p-4 text-sm text-card-foreground ring-1 ring-foreground/10">
        <ProgressBar
          value={Math.round((done / steps.length) * 100)}
          aria-labelledby={headingId}
          label={
            <h2 id={headingId} className="text-base font-bold">
              Keep a record of the results
            </h2>
          }
          valueText={`${done} of ${steps.length} steps`}
        />
        <p className="mt-2 text-muted-foreground">
          GlideComp re-scores competitions when the scoring rules change, so the
          scores online can move after the competition ends. Download the results
          as they stand now and keep the file with your records.
        </p>
        <ol className="mt-3 space-y-1.5">
          {steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2">
              {step.complete ? (
                <Check aria-hidden className="size-4 shrink-0 text-primary" />
              ) : (
                <Circle aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className={step.complete ? "text-muted-foreground" : ""}>
                {step.complete ? <span className="sr-only">Completed: </span> : null}
                {stepControl(step)}
              </span>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onPress={hide}>
            Hide
          </Button>
        </div>
      </div>
    </section>
  );
}
