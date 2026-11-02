/**
 * One pilot's editor — a PAGE of its own (/comp/:id/pilots/:pilotId, or
 * /pilots/new), reached from a row of the pilots list (comp/PilotList.tsx) or
 * its +. The route lives in pages/CompPilotPage.tsx; this is the form.
 *
 * **A page, not a sheet over the list.** It was a full-screen sheet until
 * 2026-11, and on an iPhone that sheet sometimes stopped answering taps: a
 * fixed layer over a scrolled page, after a keyboard had come and gone, was
 * drawn in one place and hit-tested in another. Every workaround (scroll
 * locks, history entries for Back, scroll resets) imitated something a page
 * does natively, so editing became a page: Back is the browser's Back, the
 * keyboard behaves as on any form, and the list keeps its scroll by the
 * router's restoration. See the overlays rule in CLAUDE.md.
 *
 * **Done saves this pilot, and only this pilot.** An existing pilot is a PATCH
 * of the fields that changed (comp/pilot-edit.ts), a new one a POST. A pilot
 * is a row of its own on the server, with its own audited route, so there is
 * nothing to batch — and on a hill with one bar of signal, a morning of
 * roster edits waiting on one Save is a morning one stray tap can lose.
 *
 * It is a kit `Form` (rac/form.tsx), which owns what happens when Done does
 * not work: the form's own checks and the server's refusals land under the
 * field they are about, focused and scrolled into view. Field `name`s are
 * what the server's refusals are mapped onto (SERVER_FIELDS).
 *
 * Leaving with unsaved edits asks first for a reload, a tab close or a link;
 * Back is left to the browser, as on any page.
 *
 * Remove is at the foot, apart from everything else, and asks first — naming
 * the tracks that go with the pilot.
 */
import { useState } from "react";
import { Trash2Icon } from "lucide-react";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button } from "@/react/rac/button";
import { TextField } from "@/react/rac/field";
import { FIELD_NAME, asFieldNames } from "./pilot-field-names";
import {
  Form,
  FormErrorBanner,
  FormSection,
  SubmitButton,
  UNREACHABLE,
  readRefusal,
  useFormState,
} from "@/react/rac/form";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { SectionHeader } from "../components/SectionHeader";
import { api } from "../../comp/api";
import { useConfirm } from "../lib/confirm";
import { underCompPilots } from "../lib/crumbs";
import { toast } from "../lib/toast";
import { useUnsavedChangesGuard } from "../lib/use-unsaved-changes-guard";
import { formatRankingMonth, listLabel } from "./civl-rankings";
import { emptyRow, normalizeRow, pilotToRow, type CompPilot, type ParsedRow } from "./csv";
import { createBody, draftProblems, isBlankDraft, isDirtyDraft, patchBody } from "./pilot-edit";
import { TeamField } from "./TeamField";
import { matchTeam, teamKey, type RosterTeam } from "./team-names";

/** The sporting-body IDs in the "Other IDs" group, in the CSV's order. */
const OTHER_IDS = [
  ["safa_id", "SAFA ID"],
  ["ushpa_id", "USHPA ID"],
  ["bhpa_id", "BHPA ID"],
  ["dhv_id", "DHV ID"],
  ["ffvl_id", "FFVL ID"],
  ["fai_id", "FAI ID"],
] as const;

/** The server's name for each field → the field's `name` in this form. */
const SERVER_FIELDS: Record<string, string> = {
  registered_pilot_name: FIELD_NAME.name,
  registered_pilot_email: FIELD_NAME.email,
  registered_pilot_glider: "glider",
  registered_pilot_civl_id: "civl_id",
  registered_pilot_safa_id: "safa_id",
  registered_pilot_ushpa_id: "ushpa_id",
  registered_pilot_bhpa_id: "bhpa_id",
  registered_pilot_dhv_id: "dhv_id",
  registered_pilot_ffvl_id: "ffvl_id",
  registered_pilot_fai_id: "fai_id",
  team_name: FIELD_NAME.team_name,
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

export function PilotForm({
  compId,
  compName,
  compClasses,
  pilot,
  initialName,
  teams,
  onDone,
}: {
  /** The comp's id as it goes in URLs (share key and all, for a hidden comp). */
  compId: string;
  compName: string;
  compClasses: string[];
  /** The pilot to edit, or null for a new one. */
  pilot: CompPilot | null;
  /** The roster's teams, for the Team field (comp/TeamField.tsx). */
  teams: RosterTeam[];
  /** A new pilot's name, from a search that found nobody. */
  initialName?: string;
  /** Saved, removed, or Done with nothing changed: back to the list. */
  onDone: () => void;
}) {
  const [start] = useState<ParsedRow>(() =>
    pilot ? pilotToRow(pilot) : { ...emptyRow(compClasses), name: initialName ?? "" }
  );
  const [draft, setDraft] = useState<ParsedRow>(start);
  // The team name "New team" was chosen for, if any: a name that is no team
  // saves only once that choice has been made.
  const [newTeam, setNewTeam] = useState<string | null>(null);
  // Set the moment a save or a remove lands, so the guard stands down before
  // the page navigates away.
  const [finished, setFinished] = useState(false);

  /**
   * The draft as it will be sent: a team name that IS a roster team (only
   * case, spacing or accents differ) goes under the roster's spelling.
   */
  const toSend = (): ParsedRow => {
    const team = draft.team_name?.trim() ?? "";
    const exact = team ? matchTeam(team, teams).exact : null;
    return exact ? { ...draft, team_name: exact.name } : draft;
  };

  /** The form's own checks: the draft's, then the team's. */
  const problems = (): Record<string, string | undefined> => {
    const found: Record<string, string | undefined> = draftProblems(draft, compClasses);
    const team = draft.team_name?.trim() ?? "";
    const unchanged = !!pilot && teamKey(team) === teamKey(pilot.team_name ?? "");
    const chosen = newTeam !== null && teamKey(newTeam) === teamKey(team);
    if (team && !unchanged && !chosen && !matchTeam(team, teams).exact) {
      found.team_name = `Choose a team from the list, or New team: ${team}.`;
    }
    return found;
  };

  /** Whether leaving would lose anything. */
  const unsaved = pilot ? isDirtyDraft(start, draft) : !isBlankDraft(draft);

  useUnsavedChangesGuard(unsaved && !finished, {
    title: "Discard changes?",
    message: pilot ? `Your changes to ${pilot.name} are not saved.` : "This pilot is not saved.",
    guardBack: false,
  });

  const finish = () => {
    setFinished(true);
    onDone();
  };

  return (
    <div className="max-w-2xl">
      <Breadcrumbs items={underCompPilots(compId, compName)} current={pilot?.name ?? "New pilot"} />
      <Form
        validate={() => (unsaved ? asFieldNames(problems()) : {})}
        fieldNames={SERVER_FIELDS}
        onSubmit={async () => {
          if (!unsaved) return undefined;
          return pilot
            ? api.api.comp[":comp_id"].pilot[":comp_pilot_id"].$patch({
                param: { comp_id: compId, comp_pilot_id: pilot.comp_pilot_id },
                json: patchBody(pilot, toSend()),
              })
            : api.api.comp[":comp_id"].pilot.$post({
                param: { comp_id: compId },
                json: createBody(toSend()),
              });
        }}
        onSuccess={async (res) => {
          if (res) {
            const saved = (await res.json()) as unknown as CompPilot;
            toast.success(`Saved ${saved.name}`);
          }
          finish();
        }}
      >
        {/* Done where the sheet had it, top right: in reach without
            scrolling past the whole form. */}
        <SectionHeader
          as="h1"
          className="mt-2"
          title={normalizeRow(draft).name || pilot?.name || "New pilot"}
          action={<SubmitButton>Done</SubmitButton>}
        />
        <FormErrorBanner className="mt-3" />
        <div className="mt-4">
          <PilotFields
            compId={compId}
            compClasses={compClasses}
            pilot={pilot}
            draft={draft}
            setDraft={setDraft}
            teams={teams}
            onNewTeam={setNewTeam}
            onRemoved={finish}
          />
        </div>
      </Form>
    </div>
  );
}

/** The form's body: inside it, so it can read and report its errors. */
function PilotFields({
  compId,
  compClasses,
  pilot,
  draft,
  setDraft,
  teams,
  onNewTeam,
  onRemoved,
}: {
  compId: string;
  compClasses: string[];
  pilot: CompPilot | null;
  draft: ParsedRow;
  setDraft: React.Dispatch<React.SetStateAction<ParsedRow>>;
  teams: RosterTeam[];
  onNewTeam: (name: string) => void;
  onRemoved: () => void;
}) {
  const confirm = useConfirm();
  const { pending, setFormError } = useFormState();
  const [removing, setRemoving] = useState(false);

  const set = (key: DraftKey, value: string) =>
    setDraft((d) =>
      key === "wprs_points"
        ? // A typed score is the organiser's own number, so the list and
          // month it may have come from stop being true of it.
          { ...d, wprs_points: value, civl_ranking_slug: null, civl_ranking_date: null }
        : { ...d, [key]: value }
    );
  const text = (key: DraftKey) => (draft[key] ?? "") as string;

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
      onRemoved();
    } catch {
      setFormError(UNREACHABLE);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      {/* Six named parts, in the order an organiser fills them in, and none
          folds away: Other IDs used to, and a field behind a fold is one
          nobody finds — the reader scanning for it, or the kit moving focus
          to it when it is the field with the problem. */}
      <div className="flex flex-col gap-4">
        <FormSection title="Required">
          <TextField
            label="Name"
            name={FIELD_NAME.name}
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
        </FormSection>

        {/* The glider is how people pick the pilot out in the air (and a
            rough read of their flying). Nothing scores it, so it can be as
            descriptive as a spotter needs. */}
        <FormSection title="In the air">
          <TextField
            label="Glider"
            name="glider"
            autoComplete="off"
            value={text("glider")}
            onChange={(v) => set("glider", v)}
            description="Make, model and colours, so they can be picked out in the air — e.g. green and yellow Airborne F2-190."
          />
        </FormSection>

        <FormSection title="Contact">
          {pilot?.linked ? (
            <p className="text-sm text-muted-foreground">
              {pilot.linked_username
                ? `Linked to @${pilot.linked_username}`
                : "Linked to a GlideComp account"}
            </p>
          ) : null}
          <TextField
            label="Email"
            name={FIELD_NAME.email}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={text("email")}
            onChange={(v) => set("email", v)}
            description="The address they sign in with — it's how their tracks find them."
          />
        </FormSection>

        <FormSection title="CIVL">
          <TextField
            label="CIVL ID"
            name="civl_id"
            inputMode="numeric"
            autoComplete="off"
            value={text("civl_id")}
            onChange={(v) => set("civl_id", v)}
          />
          {/* Spelled out: an organiser filling in a roster may not know the
              acronym, and this is where they meet the number. */}
          <TextField
            label="World Pilot Ranking Scheme points"
            name="wprs_points"
            inputMode="decimal"
            autoComplete="off"
            value={text("wprs_points")}
            onChange={(v) => set("wprs_points", v)}
            description={pointsSource(draft)}
          />
        </FormSection>

        <FormSection title="Team">
          <TeamField
            value={text("team_name")}
            onChange={(v) => set("team_name", v)}
            teams={teams}
            onNewTeam={onNewTeam}
          />
          <TextField
            label="Driver"
            name="driver_contact"
            autoComplete="off"
            value={text("driver_contact")}
            onChange={(v) => set("driver_contact", v)}
          />
        </FormSection>

        <FormSection title="Other IDs">
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
        </FormSection>

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
