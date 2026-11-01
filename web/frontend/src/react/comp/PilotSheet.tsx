/**
 * One pilot, at full screen — the sheet behind each row of the pilots list
 * (comp/PilotList.tsx), and behind the + for a new one.
 *
 * **Done saves this pilot, and only this pilot.** An existing pilot is a PATCH
 * of the fields that changed (comp/pilot-edit.ts), a new one a POST. That is
 * the difference from the waypoint and turnpoint sheets, whose drafts wait
 * for a page-level Save: a pilot is a row of its own on the server, with its
 * own audited route, so there is nothing to batch — and on a hill with one bar
 * of signal, a morning of roster edits waiting on one Save is a morning that
 * one stray tap can lose. Each pilot is saved the moment it is done.
 *
 * Because closing SAVES, the other ways out — Back, Escape, a press outside —
 * cannot quietly do the same: they ask before discarding a dirty draft
 * (`confirmDismiss`), and leave a clean one at once. A failed save keeps the
 * sheet open with the server's reason at the top, so nothing typed is lost to
 * a dropped request.
 *
 * Remove is at the foot, apart from everything else, and asks first — naming
 * the tracks that go with the pilot. In the grid it replaced, removing a pilot
 * was a ✕ in a frozen column beside their name, one mis-tap from deleting
 * their tracks on the next save.
 */
import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Button } from "@/react/rac/button";
import { Disclosure } from "@/react/rac/disclosure";
import { TextField } from "@/react/rac/field";
import { FullScreenSheet, SheetBody, SheetHeader } from "@/react/rac/full-screen-sheet";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { api } from "../../comp/api";
import { useConfirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import { formatRankingMonth, listLabel } from "./civl-rankings";
import {
  emptyRow,
  normalizeRow,
  pilotToRow,
  serverErrorMessage,
  type CompPilot,
  type ParsedRow,
} from "./csv";
import { createBody, draftProblems, isBlankDraft, isDirtyDraft, patchBody } from "./pilot-edit";

/** The sporting-body IDs behind the "Other IDs" fold, in the CSV's order. */
const OTHER_IDS = [
  ["safa_id", "SAFA ID"],
  ["ushpa_id", "USHPA ID"],
  ["bhpa_id", "BHPA ID"],
  ["dhv_id", "DHV ID"],
  ["ffvl_id", "FFVL ID"],
  ["fai_id", "FAI ID"],
] as const;

type DraftKey = Exclude<keyof ParsedRow, "comp_pilot_id">;

/**
 * Where a score came from, under the field that holds it: the CIVL list and
 * month a fill copied it from, or that an organiser typed it.
 */
function pointsSource(draft: ParsedRow): string | undefined {
  if (!normalizeRow(draft).wprs_points) return undefined;
  if (!draft.civl_ranking_slug) return "Set by an organiser";
  return `From ${listLabel(draft.civl_ranking_slug)}, ${formatRankingMonth(draft.civl_ranking_date ?? null)}`;
}

export function PilotSheet({
  compId,
  compClasses,
  pilot,
  initialName,
  onSaved,
  onRemoved,
  onClose,
}: {
  compId: string;
  compClasses: string[];
  /** The pilot to edit, or null for a new one. */
  pilot: CompPilot | null;
  /** A new pilot's name, from a search that found nobody. */
  initialName?: string;
  onSaved: (saved: CompPilot) => void;
  onRemoved: (removed: CompPilot) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [start] = useState<ParsedRow>(() =>
    pilot ? pilotToRow(pilot) : { ...emptyRow(compClasses), name: initialName ?? "" }
  );
  const [draft, setDraft] = useState<ParsedRow>(start);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Field errors wait for the first Done: a form that turns red while it is
  // still being filled in is complaining about work in progress.
  const [checked, setChecked] = useState(false);

  const set = (key: DraftKey, value: string) =>
    setDraft((d) =>
      key === "wprs_points"
        ? // A typed score is the organiser's own number, so the list and
          // month it may have come from stop being true of it.
          { ...d, wprs_points: value, civl_ranking_slug: null, civl_ranking_date: null }
        : { ...d, [key]: value }
    );
  const text = (key: DraftKey) => (draft[key] ?? "") as string;

  /** Whether closing would lose anything. */
  const unsaved = pilot ? isDirtyDraft(start, draft) : !isBlankDraft(draft);
  const problems = checked ? draftProblems(draft, compClasses) : {};
  const shownName = normalizeRow(draft).name || pilot?.name || "New pilot";

  async function done() {
    if (!unsaved) {
      onClose();
      return;
    }
    setChecked(true);
    if (Object.keys(draftProblems(draft, compClasses)).length > 0) return;

    setSaving(true);
    setError(null);
    try {
      const res = pilot
        ? await api.api.comp[":comp_id"].pilot[":comp_pilot_id"].$patch({
            param: { comp_id: compId, comp_pilot_id: pilot.comp_pilot_id },
            json: patchBody(pilot, draft),
          })
        : await api.api.comp[":comp_id"].pilot.$post({
            param: { comp_id: compId },
            json: createBody(draft),
          });
      if (!res.ok) {
        setError(serverErrorMessage(await res.text()));
        return;
      }
      const saved = (await res.json()) as unknown as CompPilot;
      toast.success(`Saved ${saved.name}`);
      onSaved(saved);
    } catch {
      setError("Could not reach GlideComp. Check your connection, then press Done again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!pilot) return;
    const n = pilot.track_count;
    const ok = await confirm({
      title: `Remove ${pilot.name}?`,
      message: n > 0 ? `Their ${n} track${n === 1 ? "" : "s"} will be deleted too.` : undefined,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await api.api.comp[":comp_id"].pilot[":comp_pilot_id"].$delete({
        param: { comp_id: compId, comp_pilot_id: pilot.comp_pilot_id },
      });
      if (!res.ok) {
        setError(serverErrorMessage(await res.text()));
        return;
      }
      toast.success(`Removed ${pilot.name}`);
      onRemoved(pilot);
    } catch {
      setError("Could not reach GlideComp. Check your connection, then try again.");
    } finally {
      setRemoving(false);
    }
  }

  const otherIdsSet = OTHER_IDS.filter(([key]) => text(key).trim() !== "").map(([, label]) =>
    label.replace(" ID", "")
  );

  return (
    <FullScreenSheet
      label={pilot ? `${pilot.name} details` : "New pilot"}
      onClose={onClose}
      confirmDismiss={() =>
        unsaved
          ? confirm({
              title: "Discard changes?",
              message: pilot
                ? `Your changes to ${pilot.name} are not saved.`
                : "This pilot is not saved.",
              confirmLabel: "Discard changes",
              cancelLabel: "Keep editing",
              destructive: true,
            })
          : true
      }
      className="flex flex-col"
    >
      <SheetHeader
        title={shownName}
        action={
          <Button
            autoFocus
            isPending={saving}
            pendingLabel="Saving"
            isDisabled={removing}
            onPress={() => void done()}
          >
            Done
          </Button>
        }
      />

      <SheetBody>
        <div className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {pilot?.linked ? (
            <p className="text-sm text-muted-foreground">
              {pilot.linked_username
                ? `Linked to @${pilot.linked_username}`
                : "Linked to a GlideComp account"}
            </p>
          ) : null}

          <TextField
            label="Name"
            value={text("name")}
            onChange={(v) => set("name", v)}
            autoComplete="off"
            isInvalid={!!problems.name}
            errorMessage={problems.name}
          />

          <RadioGroup
            label="Class"
            value={draft.pilot_class || null}
            onChange={(v) => set("pilot_class", v)}
            orientation="horizontal"
            isInvalid={!!problems.pilot_class}
            errorMessage={problems.pilot_class}
          >
            {/* A row of thumb-sized targets: the kit's radio is as tall as its
                text, and a comp's classes are few enough to sit side by side. */}
            <div className="flex flex-wrap gap-x-5">
              {compClasses.map((c) => (
                <Radio key={c} value={c} className="min-h-11 pr-1 text-base md:text-sm">
                  {c}
                </Radio>
              ))}
            </div>
          </RadioGroup>

          <TextField
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={text("email")}
            onChange={(v) => set("email", v)}
            description="The address they sign in with — it's how their tracks find them."
            isInvalid={!!problems.email}
            errorMessage={problems.email}
          />

          <TextField
            label="Glider"
            autoComplete="off"
            value={text("glider")}
            onChange={(v) => set("glider", v)}
          />

          <TextField
            label="WPRS points"
            inputMode="decimal"
            autoComplete="off"
            value={text("wprs_points")}
            onChange={(v) => set("wprs_points", v)}
            description={pointsSource(draft)}
            isInvalid={!!problems.wprs_points}
            errorMessage={problems.wprs_points}
          />

          <TextField
            label="CIVL ID"
            inputMode="numeric"
            autoComplete="off"
            value={text("civl_id")}
            onChange={(v) => set("civl_id", v)}
          />

          <TextField
            label="Team"
            autoComplete="off"
            value={text("team_name")}
            onChange={(v) => set("team_name", v)}
          />

          <TextField
            label="Driver"
            autoComplete="off"
            value={text("driver_contact")}
            onChange={(v) => set("driver_contact", v)}
          />

          <Disclosure
            title="Other IDs"
            headingLevel={3}
            badge={
              otherIdsSet.length > 0 ? (
                <span className="text-sm text-muted-foreground">
                  ({otherIdsSet.join(", ")} set)
                </span>
              ) : null
            }
          >
            <div className="flex flex-col gap-4 pt-3">
              {OTHER_IDS.map(([key, label]) => (
                <TextField
                  key={key}
                  label={label}
                  autoComplete="off"
                  value={text(key)}
                  onChange={(v) => set(key, v)}
                />
              ))}
            </div>
          </Disclosure>
        </div>

        {pilot ? (
          <div className="mt-8 border-t border-border pt-4">
            <Button
              variant="destructive"
              isPending={removing}
              pendingLabel="Removing"
              isDisabled={saving}
              onPress={() => void remove()}
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
              Remove this pilot
            </Button>
          </div>
        ) : null}
      </SheetBody>
    </FullScreenSheet>
  );
}
