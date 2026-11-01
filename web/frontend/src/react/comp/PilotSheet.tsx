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
 * It is a kit `FormSheet` (rac/form.tsx), which owns what happens when Done
 * does not work: the form's own checks and the server's refusals land under
 * the field they are about, focused and scrolled into view, and anything
 * about no field in particular is pinned under the header. Before that, a
 * refusal sat at the top of a body the organiser had scrolled past, and Done
 * looked broken. Field `name`s are what the server's refusals are mapped onto
 * (SERVER_FIELDS).
 *
 * Because closing SAVES, the other ways out — Back, Escape, a press outside —
 * cannot quietly do the same: they ask before discarding a dirty draft
 * (`confirmDismiss`), and leave a clean one at once.
 *
 * Remove is at the foot, apart from everything else, and asks first — naming
 * the tracks that go with the pilot. In the grid it replaced, removing a pilot
 * was a ✕ in a frozen column beside their name, one mis-tap from deleting
 * their tracks on the next save.
 */
import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { Button } from "@/react/rac/button";
import { Disclosure } from "@/react/rac/disclosure";
import { TextField } from "@/react/rac/field";
import { FormSheet, UNREACHABLE, readRefusal, useFormState } from "@/react/rac/form";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { api } from "../../comp/api";
import { useConfirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import { formatRankingMonth, listLabel } from "./civl-rankings";
import { emptyRow, normalizeRow, pilotToRow, type CompPilot, type ParsedRow } from "./csv";
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

/** The server's name for each field → the field's `name` in this sheet. */
const SERVER_FIELDS: Record<string, string> = {
  registered_pilot_name: "name",
  registered_pilot_email: "email",
  registered_pilot_glider: "glider",
  registered_pilot_civl_id: "civl_id",
  registered_pilot_safa_id: "safa_id",
  registered_pilot_ushpa_id: "ushpa_id",
  registered_pilot_bhpa_id: "bhpa_id",
  registered_pilot_dhv_id: "dhv_id",
  registered_pilot_ffvl_id: "ffvl_id",
  registered_pilot_fai_id: "fai_id",
};

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

  /** Whether closing would lose anything. */
  const unsaved = pilot ? isDirtyDraft(start, draft) : !isBlankDraft(draft);

  return (
    <FormSheet
      label={pilot ? `${pilot.name} details` : "New pilot"}
      title={normalizeRow(draft).name || pilot?.name || "New pilot"}
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
      validate={() => (unsaved ? draftProblems(draft, compClasses) : {})}
      fieldNames={SERVER_FIELDS}
      onSubmit={async () => {
        if (!unsaved) return undefined;
        return pilot
          ? api.api.comp[":comp_id"].pilot[":comp_pilot_id"].$patch({
              param: { comp_id: compId, comp_pilot_id: pilot.comp_pilot_id },
              json: patchBody(pilot, draft),
            })
          : api.api.comp[":comp_id"].pilot.$post({
              param: { comp_id: compId },
              json: createBody(draft),
            });
      }}
      onSuccess={async (res) => {
        if (!res) {
          onClose();
          return;
        }
        const saved = (await res.json()) as unknown as CompPilot;
        toast.success(`Saved ${saved.name}`);
        onSaved(saved);
      }}
    >
      <PilotFields
        compId={compId}
        compClasses={compClasses}
        pilot={pilot}
        draft={draft}
        setDraft={setDraft}
        onRemoved={onRemoved}
      />
    </FormSheet>
  );
}

/** The sheet's body: inside the form, so it can read and report its errors. */
function PilotFields({
  compId,
  compClasses,
  pilot,
  draft,
  setDraft,
  onRemoved,
}: {
  compId: string;
  compClasses: string[];
  pilot: CompPilot | null;
  draft: ParsedRow;
  setDraft: React.Dispatch<React.SetStateAction<ParsedRow>>;
  onRemoved: (removed: CompPilot) => void;
}) {
  const confirm = useConfirm();
  const { fieldErrors, pending, setFormError } = useFormState();
  const [removing, setRemoving] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);

  const set = (key: DraftKey, value: string) =>
    setDraft((d) =>
      key === "wprs_points"
        ? // A typed score is the organiser's own number, so the list and
          // month it may have come from stop being true of it.
          { ...d, wprs_points: value, civl_ranking_slug: null, civl_ranking_date: null }
        : { ...d, [key]: value }
    );
  const text = (key: DraftKey) => (draft[key] ?? "") as string;

  // An error on a field behind the fold opens the fold: the kit focuses the
  // field with the problem, and a collapsed one cannot take focus.
  const otherIdError = OTHER_IDS.some(([key]) => fieldErrors[key]);
  const otherIdsSet = OTHER_IDS.filter(([key]) => text(key).trim() !== "").map(([, label]) =>
    label.replace(" ID", "")
  );

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
    setFormError(null);
    try {
      const res = await api.api.comp[":comp_id"].pilot[":comp_pilot_id"].$delete({
        param: { comp_id: compId, comp_pilot_id: pilot.comp_pilot_id },
      });
      if (!res.ok) {
        setFormError((await readRefusal(res)).message);
        return;
      }
      toast.success(`Removed ${pilot.name}`);
      onRemoved(pilot);
    } catch {
      setFormError(UNREACHABLE);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        {pilot?.linked ? (
          <p className="text-sm text-muted-foreground">
            {pilot.linked_username
              ? `Linked to @${pilot.linked_username}`
              : "Linked to a GlideComp account"}
          </p>
        ) : null}

        <TextField
          label="Name"
          name="name"
          value={text("name")}
          onChange={(v) => set("name", v)}
          autoComplete="off"
        />

        <RadioGroup
          label="Class"
          name="pilot_class"
          value={draft.pilot_class || null}
          onChange={(v) => set("pilot_class", v)}
          orientation="horizontal"
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
          name="email"
          type="email"
          inputMode="email"
          autoComplete="off"
          value={text("email")}
          onChange={(v) => set("email", v)}
          description="The address they sign in with — it's how their tracks find them."
        />

        <TextField
          label="Glider"
          name="glider"
          autoComplete="off"
          value={text("glider")}
          onChange={(v) => set("glider", v)}
        />

        <TextField
          label="WPRS points"
          name="wprs_points"
          inputMode="decimal"
          autoComplete="off"
          value={text("wprs_points")}
          onChange={(v) => set("wprs_points", v)}
          description={pointsSource(draft)}
        />

        <TextField
          label="CIVL ID"
          name="civl_id"
          inputMode="numeric"
          autoComplete="off"
          value={text("civl_id")}
          onChange={(v) => set("civl_id", v)}
        />

        <TextField
          label="Team"
          name="team_name"
          autoComplete="off"
          value={text("team_name")}
          onChange={(v) => set("team_name", v)}
        />

        <TextField
          label="Driver"
          name="driver_contact"
          autoComplete="off"
          value={text("driver_contact")}
          onChange={(v) => set("driver_contact", v)}
        />

        <Disclosure
          title="Other IDs"
          headingLevel={3}
          isExpanded={othersOpen || otherIdError}
          onExpandedChange={setOthersOpen}
          badge={
            otherIdsSet.length > 0 ? (
              <span className="text-sm text-muted-foreground">({otherIdsSet.join(", ")} set)</span>
            ) : null
          }
        >
          <div className="flex flex-col gap-4 pt-3">
            {OTHER_IDS.map(([key, label]) => (
              <TextField
                key={key}
                label={label}
                name={key}
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
            isDisabled={pending}
            onPress={() => void remove()}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
            Remove this pilot
          </Button>
        </div>
      ) : null}
    </>
  );
}
