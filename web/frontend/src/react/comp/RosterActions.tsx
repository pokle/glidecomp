/**
 * The pilots page's roster-wide actions, behind its ⋯ menu: import a CSV,
 * export one, fill from the CIVL rankings, add test pilots.
 *
 * In the grid these edited the GRID, and nothing was written until Save — a
 * fill or an import the organiser disagreed with was undone by Cancel. With
 * the grid gone each one writes straight to the roster, so each one that
 * changes many pilots shows exactly what it will write first and writes it
 * only on a second press: the import as a review naming every pilot it adds,
 * updates and removes (with the tracks that go with them), the CIVL fill as
 * the list of IDs and points it is about to set. The same shape as the
 * waypoints page's Check altitudes, and for the same reason.
 *
 * **Each is a page under the list** (#810), where they were full-screen
 * sheets over it — the overlays rule in CLAUDE.md:
 *
 *   - /pilots/import (pages/CompRosterImportPage.tsx): what a CSV must look
 *     like and the button that picks one, then — on the same page — the
 *     review of that file. The file is a DRAFT (`rosterImportDraft`, see
 *     lib/draft-store.ts and docs/drafts.md): read in the browser, kept in
 *     this tab's storage, so a reload comes back to the review rather than to
 *     the list. With no draft to read (a shared link, a new tab, a draft
 *     discarded) the page simply asks for the file again.
 *   - /pilots/civl-fill (pages/CompCivlFillPage.tsx): it asks the rankings
 *     itself, about the roster the page fetched.
 *
 * Both are kit forms (rac/form.tsx): a refusal is pinned under the heading,
 * never a toast. Both write through the bulk route with a `remove` list and
 * ONLY the rows that change, so a pilot who joins while a review is open is
 * left alone — and the audit log and the score bump happen there, on the
 * server, as they always have.
 */
import { useEffect, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { EllipsisIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { Disclosure } from "@/react/rac/disclosure";
import {
  Form,
  FormErrorBanner,
  SubmitButton,
  useFormAction,
  useFormState,
} from "@/react/rac/form";
import { Menu, MenuItem, MenuTrigger } from "@/react/rac/menu";
import { Loading } from "@/react/rac/progress";
import { SettingsPage } from "../components/SettingsPage";
import { SectionHeader } from "../components/SectionHeader";
import { api } from "../../comp/api";
import { underCompPilots } from "../lib/crumbs";
import { defineDraft } from "../lib/draft-store";
import { toast } from "../lib/toast";
import {
  fillCivlIds,
  fillRankings,
  formatRankingMonth,
  listLabel,
  lookupRankings,
} from "./civl-rankings";
import {
  COLUMNS,
  normalizeRow,
  parsedRowToBulk,
  pilotToRow,
  type BulkPilotRow,
  type CompPilot,
} from "./csv";
import {
  listInWords,
  planChanges,
  planRequest,
  type ImportPlan,
  type ProblemRows,
} from "./roster-import";

export function RosterActionsMenu({
  onImport,
  onExport,
  onFillCivl,
  onCopyFromComp,
  onAddTestPilots,
}: {
  onImport: () => void;
  onExport: () => void;
  onFillCivl: () => void;
  /** Copy another competition's pilots in (pages/CompPilotsCopyPage.tsx). */
  onCopyFromComp: () => void;
  onAddTestPilots: () => void;
}) {
  return (
    <MenuTrigger>
      <Button variant="outline" size="icon" aria-label="Roster actions">
        <EllipsisIcon aria-hidden="true" />
      </Button>
      <Menu placement="bottom end">
        {/* The trailing "…" marks an action that asks something before it
            acts (see ScoresDownload's "Open in Google Sheets…"). */}
        <MenuItem onAction={onImport}>Import CSV…</MenuItem>
        <MenuItem onAction={onExport}>Export CSV</MenuItem>
        <MenuItem onAction={onFillCivl}>Fill from CIVL…</MenuItem>
        <MenuItem onAction={onCopyFromComp}>Copy from another competition…</MenuItem>
        <MenuItem onAction={onAddTestPilots}>Add test pilots</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

/**
 * A CSV file chosen for import and not yet applied: what the review page
 * reads back after a reload. The FILE, not the plan worked out from it — the
 * page plans it again against the roster it fetched, so the review is always
 * of the roster as it is now.
 */
export interface RosterImportDraft {
  fileName: string;
  text: string;
  /**
   * The review's "Put them in …": every pilot in a class the comp does not
   * have goes in this one. Part of the draft so a reload keeps the choice.
   */
  unknownClassAs?: string;
}

/** One per comp (keyed `[bareCompId]`), in this tab, for the signed-in user. */
export const rosterImportDraft = defineDraft<RosterImportDraft>({
  kind: "roster-import",
  version: 1,
  isValid: (v): v is RosterImportDraft =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as RosterImportDraft).fileName === "string" &&
    typeof (v as RosterImportDraft).text === "string" &&
    ["string", "undefined"].includes(typeof (v as RosterImportDraft).unknownClassAs),
});

/**
 * What a CSV must look like, and the button that picks one. This is the
 * onboarding the grid's empty placeholder used to carry, moved to where it is
 * needed: the moment someone imports.
 */
export function ImportCsvPicker({
  compId,
  compName,
  onChosen,
}: {
  compId: string;
  compName: string;
  onChosen: (draft: RosterImportDraft) => void;
}) {
  async function choose(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    onChosen({ fileName: file.name, text: await file.text() });
  }

  return (
    <SettingsPage crumbs={underCompPilots(compId, compName)} title="Import CSV">
      <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
        <li>
          Only <strong>name</strong> and <strong>class</strong> are required — every other
          column, including all the sporting-body IDs, is optional.
        </li>
        <li>
          CSV imports need a header row naming the columns (
          {COLUMNS.map((c) => c.header).join(", ")}). Column order and capitalisation don't
          matter, and unrecognised columns are ignored.
        </li>
        <li>
          Pilots are matched to the IGC tracks they upload by <strong>email</strong> — enter
          the address each pilot signs in to GlideComp with (e.g. their Gmail address).
        </li>
        <li>
          Tip: <strong>Export CSV</strong> now to download a blank template you can fill in
          with your favourite spreadsheet (Excel, Numbers, Google Sheets…).
        </li>
      </ul>
      <div>
        <FileTrigger
          acceptedFileTypes={[".csv", ".tsv", ".txt"]}
          onSelect={(files) => void choose(files)}
        >
          <Button>Choose file</Button>
        </FileTrigger>
      </div>
    </SettingsPage>
  );
}

/** "3 tracks", for a pilot about to be removed. Nothing for none. */
function tracksNote(n: number): string | null {
  return n > 0 ? `${n} track${n === 1 ? "" : "s"}` : null;
}

/**
 * The page's heading row: the title, then Cancel and the submit, top right —
 * where the sheet had them, in reach without scrolling past the whole list.
 * Cancel waits while the submit is in flight: leaving then would leave twice
 * once the submit landed.
 */
function ReviewHeader({
  title,
  onCancel,
  submit,
}: {
  title: string;
  onCancel: () => void;
  submit: React.ReactNode;
}) {
  const { pending } = useFormState();
  return (
    <SectionHeader
      as="h1"
      className="mt-2"
      title={<span className="[overflow-wrap:anywhere]">{title}</span>}
      action={
        <div className="flex gap-2">
          <Button variant="outline" isDisabled={pending} onPress={onCancel}>
            Cancel
          </Button>
          {submit}
        </div>
      }
    />
  );
}

export function ImportReview({
  compId,
  compName,
  plan,
  compClasses,
  fallback,
  onCancel,
  onApplied,
  onUseFallback,
  onUndoFallback,
  onClassesAdded,
}: {
  compId: string;
  compName: string;
  plan: ImportPlan;
  /** The comp's classes now, for "Its classes are …" and for adding to. */
  compClasses: string[];
  /** The class "Put them in …" puts pilots in: the comp's default. */
  fallback: string;
  /** Discard the file and leave. */
  onCancel: () => void;
  /** Applied: forget the file and leave. */
  onApplied: () => void;
  /** Put the pilots of every class the comp lacks in `fallback`. */
  onUseFallback: () => void;
  /** Take that back. */
  onUndoFallback: () => void;
  /** The comp now has these classes too. */
  onClassesAdded: (classes: string[]) => void;
}) {
  const changes = planChanges(plan);
  const summary = [
    `${plan.updated.length} updated`,
    `${plan.added.length} new`,
    `${plan.removed.length} removed`,
  ].join(" · ");
  // Nothing to apply, or a file that cannot be: the reasons are in the body.
  const canApply = plan.errors.length === 0 && changes > 0;

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompPilots(compId, compName)} current="Import CSV" />
      <Form
        onSubmit={() =>
          api.api.comp[":comp_id"].pilot.bulk.$post({
            param: { comp_id: compId },
            json: planRequest(plan),
          })
        }
        onSuccess={() => {
          toast.success(`Imported ${plan.fileName}`);
          onApplied();
        }}
      >
        <ReviewHeader
          title={`Import ${plan.fileName}`}
          onCancel={onCancel}
          submit={canApply ? <SubmitButton pendingLabel="Applying">Apply</SubmitButton> : null}
        />
        <p className="mt-1 text-sm text-muted-foreground">{summary}</p>
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-6">
          {plan.errors.length > 0 ? (
            <ImportBlocked
              compId={compId}
              compName={compName}
              plan={plan}
              compClasses={compClasses}
              fallback={fallback}
              onUseFallback={onUseFallback}
              onClassesAdded={onClassesAdded}
            />
          ) : null}
          {plan.remapped.length > 0 ? (
            <Alert>
              <AlertDescription className="flex flex-wrap items-center justify-between gap-2 [&_p:not(:last-child)]:mb-0">
                <div>
                  {plan.remapped.map((r) => (
                    <p key={r.from}>
                      {pilots(r.count)} from "{r.from}" will be in "{r.to}".
                    </p>
                  ))}
                </div>
                <Button variant="outline" size="sm" onPress={onUndoFallback}>
                  Undo
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {changes === 0 && plan.errors.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This file matches the roster. There is nothing to change.
            </p>
          ) : null}

          {/* Removed first: it is the part that cannot be undone. */}
          <ReviewSection title="Removed" count={plan.removed.length}>
            {plan.removed.map(({ pilot, sameNameAsNew }) => (
              <li key={pilot.comp_pilot_id} className="py-2">
                <p className="font-medium">{pilot.name}</p>
                <p className="text-xs text-muted-foreground">
                  {[
                    tracksNote(pilot.track_count),
                    sameNameAsNew ? "Same name as a new row in the file" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ReviewSection>
          <ReviewSection title="New" count={plan.added.length}>
            {plan.added.map((row, i) => (
              <li key={i} className="py-2 font-medium">
                {row.registered_pilot_name}
              </li>
            ))}
          </ReviewSection>
          <ReviewSection title="Updated" count={plan.updated.length}>
            {plan.updated.map(({ before }) => (
              <li key={before.comp_pilot_id} className="py-2 font-medium">
                {before.name}
              </li>
            ))}
          </ReviewSection>
        </div>
      </Form>
    </div>
  );
}

/** "1 pilot", "25 pilots". */
function pilots(n: number): string {
  return `${n} ${n === 1 ? "pilot" : "pilots"}`;
}

/**
 * Why a file cannot be imported, said once per kind of problem rather than
 * once per row — and, for the commonest one (a class this comp does not
 * have, as in a roster exported from another competition), the two ways out:
 * add the class, or put those pilots in the comp's default class. Each
 * group's rows are behind a disclosure, in the parser's own words.
 */
function ImportBlocked({
  compId,
  compName,
  plan,
  compClasses,
  fallback,
  onUseFallback,
  onClassesAdded,
}: {
  compId: string;
  compName: string;
  plan: ImportPlan;
  compClasses: string[];
  fallback: string;
  onUseFallback: () => void;
  onClassesAdded: (classes: string[]) => void;
}) {
  const { pending } = useFormState();
  const adding = useFormAction();
  const { unknownClasses, noName, noClass, other } = plan.problems;
  const missing = unknownClasses.map((g) => g.cls);
  const quoted = listInWords(missing.map((c) => `"${c}"`));
  const strayCount = unknownClasses.reduce((n, g) => n + g.rows.length, 0);

  // The comp's PATCH, as the Classes settings page sends it: the server
  // audits it and marks the scores stale. A refusal goes where the form's
  // own do, never to a toast.
  const addClasses = async () => {
    const classes = [...compClasses, ...missing];
    const res = await adding.run(() =>
      api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: { pilot_classes: classes },
      })
    );
    if (res) onClassesAdded(classes);
  };

  return (
    <Alert variant="destructive">
      {/* The gaps are the stack's: the kit's paragraph margin would double them. */}
      <AlertDescription className="flex flex-col gap-3 [&_p:not(:last-child)]:mb-0">
        <p className="font-semibold">This file can’t be imported yet.</p>
        {unknownClasses.length > 0 ? (
          <div className="flex flex-col gap-2">
            {unknownClasses.map((g) => (
              <p key={g.cls}>
                {g.rows.length === 1 ? "1 pilot is" : `${g.rows.length} pilots are`} in the class "
                {g.cls}", which {compName} doesn’t have. Its classes are{" "}
                {listInWords(compClasses)}.
              </p>
            ))}
            <p>
              Either add the {missing.length === 1 ? "class" : "classes"} to the competition, or
              put {strayCount === 1 ? "that pilot" : "those pilots"} in "{fallback}".
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                isPending={adding.pending}
                pendingLabel="Adding"
                isDisabled={pending}
                onPress={() => void addClasses()}
              >
                Add {missing.length === 1 ? "class" : "classes"} {quoted}
              </Button>
              <Button
                variant="outline"
                size="sm"
                isDisabled={pending || adding.pending}
                onPress={onUseFallback}
              >
                Put them in "{fallback}"
              </Button>
            </div>
            <ProblemRowList rows={unknownClasses.flatMap((g) => g.rows)} />
          </div>
        ) : null}
        {noName.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p>
              {noName.length === 1
                ? "1 row has no name, so it would be skipped."
                : `${noName.length} rows have no name, so they would be skipped.`}
            </p>
            <ProblemRowList rows={noName} />
          </div>
        ) : null}
        {noClass.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p>
              {noClass.length === 1 ? "1 pilot has no class." : `${noClass.length} pilots have no class.`}
            </p>
            <ProblemRowList rows={noClass} />
          </div>
        ) : null}
        {other.length > 0 ? (
          <ul className="list-disc pl-5">
            {other.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** A group's rows, folded away: the sentence above them is the finding. */
function ProblemRowList({ rows }: { rows: ProblemRows }) {
  return (
    <Disclosure
      title={rows.length === 1 ? "Show the row" : `Show the ${rows.length} rows`}
      headingLevel={3}
      className="border-t-0 pt-0"
    >
      <ul className="mt-1 list-disc pl-5">
        {rows.map((r) => (
          <li key={r.row}>{r.message}</li>
        ))}
      </ul>
    </Disclosure>
  );
}

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section>
      <h2 className="text-sm font-semibold">
        {title} ({count})
      </h2>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

/** What the fill would set on one pilot. */
interface FillChange {
  pilot: CompPilot;
  row: BulkPilotRow;
  civlId: string | null;
  points: number | null;
  source: string | null;
}

interface FillPlan {
  /** Pilots the rankings could place at all. */
  matched: number;
  changes: FillChange[];
  /** Scored pilots left alone because they already have a score. */
  alreadySet: number;
  /** The sentence the fill reports when it is done. */
  outcome: string;
}

/**
 * Work the whole fill out in memory: IDs by exact name first, then scores by
 * ID — asking the rankings again in between, because the scores are matched
 * by ID ONLY and the rows that just gained one have to be asked about by it.
 * Nothing is written; the result is what Fill would send.
 */
async function planCivlFill(compId: string, roster: CompPilot[]): Promise<FillPlan> {
  const rows = roster.map(pilotToRow);
  const first = await lookupRankings(compId, rows);
  const ids = fillCivlIds(rows, first);
  const second = await lookupRankings(compId, ids.rows);
  const ranks = fillRankings(ids.rows, second);

  const changes: FillChange[] = [];
  ranks.rows.forEach((row, i) => {
    const before = parsedRowToBulk(normalizeRow(rows[i]));
    const after = parsedRowToBulk(normalizeRow(row));
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({
      pilot: roster[i],
      row: after,
      civlId: after.registered_pilot_civl_id !== before.registered_pilot_civl_id
        ? (after.registered_pilot_civl_id ?? null)
        : null,
      points: after.wprs_points !== before.wprs_points ? (after.wprs_points ?? null) : null,
      source: row.civl_ranking_slug
        ? `${listLabel(row.civl_ranking_slug)}, ${formatRankingMonth(row.civl_ranking_date ?? null)}`
        : null,
    });
  });

  const noId = ranks.rows.filter((r) => !r.civl_id).length;
  const outcome =
    `${ids.filled} CIVL ID${ids.filled === 1 ? "" : "s"} and ` +
    `${ranks.filled} WPRS score${ranks.filled === 1 ? "" : "s"} filled in.` +
    (ranks.already_set > 0
      ? ` ${ranks.already_set} already had a score and ` +
        `${ranks.already_set === 1 ? "was" : "were"} left alone — clear one ` +
        `to refill.`
      : "") +
    (noId > 0 ? ` ${noId} row${noId === 1 ? " has" : "s have"} no ID — no exact name match.` : "");

  return { matched: first.matched_count, changes, alreadySet: ranks.already_set, outcome };
}

export function CivlFill({
  compId,
  compName,
  roster,
  onDone,
}: {
  compId: string;
  compName: string;
  /** The roster the page fetched: what the rankings are asked about. */
  roster: CompPilot[];
  /** Cancelled, or filled: leave. */
  onDone: () => void;
}) {
  const [plan, setPlan] = useState<FillPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Asked once, about the roster the page fetched when it opened.
  useEffect(() => {
    let cancelled = false;
    planCivlFill(compId, roster)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Could not read the CIVL rankings. Check your connection, then try again.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [compId, roster]);

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompPilots(compId, compName)} current="Fill from CIVL rankings" />
      <Form
        onSubmit={() =>
          api.api.comp[":comp_id"].pilot.bulk.$post({
            param: { comp_id: compId },
            json: { pilots: plan!.changes.map((c) => c.row), remove: [] },
          })
        }
        onSuccess={() => {
          toast.success(plan!.outcome);
          onDone();
        }}
      >
        <ReviewHeader
          title="Fill from CIVL rankings"
          onCancel={onDone}
          submit={
            plan && plan.changes.length > 0 ? (
              <SubmitButton pendingLabel="Filling from the rankings">Fill</SubmitButton>
            ) : null
          }
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4 flex flex-col gap-4">
          {loadError ? (
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : null}
          {plan === null ? (
            loadError ? null : <Loading className="text-sm">Reading the CIVL world rankings…</Loading>
          ) : plan.changes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {plan.alreadySet > 0
                ? `${plan.alreadySet} already had a score and ${plan.alreadySet === 1 ? "was" : "were"} left alone — clear one to refill.`
                : "No CIVL rankings match this roster. You can still type them in by hand."}
            </p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Add CIVL IDs and WPRS (World Pilot Ranking Scheme) points when missing
              </p>
              <p className="text-sm text-muted-foreground">
                {plan.matched} of {roster.length}{" "}
                {roster.length === 1 ? "pilot has" : "pilots have"} one.
              </p>
              <ul aria-label="What Fill will set" className="divide-y divide-border">
                {plan.changes.map((c) => (
                  <li key={c.pilot.comp_pilot_id} className="py-2">
                    <p className="font-medium">{c.pilot.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        c.civlId ? `CIVL ID ${c.civlId}` : null,
                        c.points !== null ? `${c.points} pts` : null,
                        c.points !== null ? c.source : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Form>
    </div>
  );
}
