/**
 * The pilots page's roster-wide actions, behind its ⋯ menu: import a CSV,
 * export one, fill from the CIVL rankings, add test pilots.
 *
 * In the grid these edited the GRID, and nothing was written until Save — a
 * fill or an import the organiser disagreed with was undone by Cancel. With
 * the grid gone each one writes straight to the roster, so each one that
 * changes many pilots shows exactly what it will write first and writes it
 * only on a second press: the import as a review sheet naming every pilot it
 * adds, updates and removes (with the tracks that go with them), the CIVL fill
 * as the list of IDs and points it is about to set. The same shape as the
 * waypoints page's Check altitudes, and for the same reason.
 *
 * Both write through the bulk route with a `remove` list and ONLY the rows
 * that change, so a pilot who joins while a review is open is left alone.
 */
import { useEffect, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { EllipsisIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { FullScreenSheet, SheetBody, SheetHeader } from "@/react/rac/full-screen-sheet";
import { Menu, MenuItem, MenuTrigger } from "@/react/rac/menu";
import { Loading } from "@/react/rac/progress";
import { api } from "../../comp/api";
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
  serverErrorMessage,
  type BulkPilotRow,
  type CompPilot,
} from "./csv";
import { planChanges, planImport, planRequest, type ImportPlan } from "./roster-import";

/** One bulk write: the changed rows, and who to remove. The whole roster back. */
async function bulkSave(
  compId: string,
  body: { pilots: BulkPilotRow[]; remove: string[] }
): Promise<CompPilot[]> {
  const res = await api.api.comp[":comp_id"].pilot.bulk.$post({
    param: { comp_id: compId },
    json: body,
  });
  if (!res.ok) throw new Error(serverErrorMessage(await res.text()));
  return ((await res.json()) as unknown as { pilots: CompPilot[] }).pilots;
}

export function RosterActionsMenu({
  onImport,
  onExport,
  onFillCivl,
  onAddTestPilots,
}: {
  onImport: () => void;
  onExport: () => void;
  onFillCivl: () => void;
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
        <MenuItem onAction={onAddTestPilots}>Add test pilots</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

/**
 * What a CSV must look like, and the button that picks one. This is the
 * onboarding the grid's empty placeholder used to carry, moved to where it is
 * needed: the moment someone imports.
 */
export function ImportCsvDialog({
  compClasses,
  roster,
  onPlanned,
  onClose,
}: {
  compClasses: string[];
  roster: CompPilot[];
  onPlanned: (plan: ImportPlan) => void;
  onClose: () => void;
}) {
  async function choose(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    onPlanned(planImport(await file.text(), file.name, roster, compClasses));
  }

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-lg"
    >
      <Dialog className="gap-3">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
        </DialogHeader>
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
        <DialogFooter>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <FileTrigger
            acceptedFileTypes={[".csv", ".tsv", ".txt"]}
            onSelect={(files) => void choose(files)}
          >
            <Button>Choose file</Button>
          </FileTrigger>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

/** "3 tracks", for a pilot about to be removed. Nothing for none. */
function tracksNote(n: number): string | null {
  return n > 0 ? `${n} track${n === 1 ? "" : "s"}` : null;
}

export function ImportReviewSheet({
  compId,
  plan,
  onApplied,
  onClose,
}: {
  compId: string;
  plan: ImportPlan;
  onApplied: (roster: CompPilot[]) => void;
  onClose: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = planChanges(plan);

  async function apply() {
    setApplying(true);
    setError(null);
    try {
      onApplied(await bulkSave(compId, planRequest(plan)));
      toast.success(`Imported ${plan.fileName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  const summary = [
    `${plan.updated.length} updated`,
    `${plan.added.length} new`,
    `${plan.removed.length} removed`,
  ].join(" · ");

  return (
    <FullScreenSheet label={`Import ${plan.fileName}`} onClose={onClose} className="flex flex-col">
      <SheetHeader
        title={`Import ${plan.fileName}`}
        description={<p className="text-sm text-muted-foreground">{summary}</p>}
        leading={
          <Button variant="outline" onPress={onClose}>
            Cancel
          </Button>
        }
        action={
          <Button
            autoFocus
            isDisabled={plan.errors.length > 0 || changes === 0}
            isPending={applying}
            pendingLabel="Applying"
            onPress={() => void apply()}
          >
            Apply
          </Button>
        }
      />
      <SheetBody className="flex flex-col gap-6">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {plan.errors.length > 0 ? (
          <Alert variant="destructive">
            <AlertDescription>
              <ul className="list-disc pl-5">
                {plan.errors.slice(0, 20).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
                {plan.errors.length > 20 ? <li>… and {plan.errors.length - 20} more</li> : null}
              </ul>
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
      </SheetBody>
    </FullScreenSheet>
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
      <h3 className="text-sm font-semibold">
        {title} ({count})
      </h3>
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

export function CivlFillSheet({
  compId,
  roster,
  onApplied,
  onClose,
}: {
  compId: string;
  roster: CompPilot[];
  onApplied: (roster: CompPilot[]) => void;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<FillPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  // Asked once, about the roster as the sheet opened on it. The sheet covers
  // the list, so nothing can change the roster under the answer from here.
  useEffect(() => {
    let cancelled = false;
    planCivlFill(compId, roster)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        if (!cancelled) {
          setError("Could not read the CIVL rankings. Check your connection, then try again.");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  async function fill() {
    if (!plan) return;
    setFilling(true);
    setError(null);
    try {
      onApplied(await bulkSave(compId, { pilots: plan.changes.map((c) => c.row), remove: [] }));
      toast.success(plan.outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setFilling(false);
    }
  }

  return (
    <FullScreenSheet label="Fill from CIVL rankings" onClose={onClose} className="flex flex-col">
      <SheetHeader
        title="Fill from CIVL rankings"
        leading={
          <Button variant="outline" onPress={onClose}>
            Cancel
          </Button>
        }
        action={
          plan && plan.changes.length > 0 ? (
            <Button
              autoFocus
              isPending={filling}
              pendingLabel="Filling from the rankings"
              onPress={() => void fill()}
            >
              Fill
            </Button>
          ) : undefined
        }
      />
      <SheetBody className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {plan === null ? (
          error ? null : <Loading className="text-sm">Reading the CIVL world rankings…</Loading>
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
              {plan.matched} of {roster.length} {roster.length === 1 ? "pilot has" : "pilots have"}{" "}
              one.
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
      </SheetBody>
    </FullScreenSheet>
  );
}
