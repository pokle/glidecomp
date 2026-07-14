/**
 * Competition settings dialog — React port of setupSettingsDialog().
 * Mounted only while open, so field state initialises fresh from the comp
 * on every open.
 */
import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { defaultsFor } from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { Label } from "@/react/ui/label";
import { RadioGroup, RadioGroupItem } from "@/react/ui/radio-group";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { CheckboxField, SearchableSelect, SimpleSelect } from "./fields";
import { type CompDetailData, type ScoringFormat } from "./types";

/**
 * Timezone dropdown options: "auto" plus every zone the runtime knows.
 * A stored zone the runtime doesn't list (e.g. saved by a newer browser)
 * is kept selectable rather than silently remapped.
 */
function timezoneOptions(current: string | null) {
  const zones: string[] =
    typeof Intl.supportedValuesOf === "function"
      ? [...Intl.supportedValuesOf("timeZone")]
      : [];
  if (current && !zones.includes(current)) zones.unshift(current);
  return [
    { value: "auto", label: "Auto — derive from the task location" },
    ...zones.map((z) => ({ value: z, label: z })),
  ];
}

export function SettingsDialog({
  compId,
  comp,
  onClose,
  onSaved,
}: {
  compId: string;
  comp: CompDetailData;
  onClose: () => void;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const ids = {
    name: useId(),
    hg: useId(),
    pg: useId(),
    pilotClasses: useId(),
    closeDate: useId(),
    adminEmails: useId(),
    nominalDistance: useId(),
    nominalTime: useId(),
    nominalGoal: useId(),
    nominalLaunch: useId(),
    minimumDistance: useId(),
    jtgFactor: useId(),
    jtgMax: useId(),
  };

  // GAP scoring parameters — fall back to the official per-category FAI
  // defaults when the comp hasn't saved any (issue #343), so the Advanced
  // section always starts from the correct official values.
  // nominalDistance stays blank when unset so the scorer auto-computes
  // it per task (70% of task distance), matching historical behavior.
  const gp = comp.gap_params ?? defaultsFor(comp.category === "pg" ? "pg" : "hg");

  const [name, setName] = useState(comp.name);
  const [category, setCategory] = useState<"hg" | "pg">(comp.category === "hg" ? "hg" : "pg");
  const [pilotClassesText, setPilotClassesText] = useState(comp.pilot_classes.join(", "));
  const [defaultClass, setDefaultClass] = useState(comp.default_pilot_class);
  const [closeDate, setCloseDate] = useState(
    comp.close_date ? comp.close_date.split("T")[0] : ""
  );
  const [test, setTest] = useState(comp.test);
  const [openUpload, setOpenUpload] = useState(comp.open_igc_upload ?? true);
  // "auto" = no explicit zone: the server derives one from the task
  // location (and re-derives when saved as auto).
  const [timezone, setTimezone] = useState(comp.timezone ?? "auto");
  const [adminsText, setAdminsText] = useState(comp.admins.map((a) => a.email).join(", "));
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(
    comp.scoring_format ?? "gap"
  );

  // Blank = "auto" (the scorer uses 70% of each task's distance). Key off the
  // *stored* value, not the per-category default, so a comp that never pinned a
  // nominal distance shows auto — matching the documented default and the
  // scorer's auto behaviour.
  const [nominalDistance, setNominalDistance] = useState(
    comp.gap_params?.nominalDistance != null
      ? String(Math.round(comp.gap_params.nominalDistance / 1000))
      : ""
  );
  const [nominalTime, setNominalTime] = useState(String(Math.round(gp.nominalTime / 60)));
  const [nominalGoal, setNominalGoal] = useState(String(Math.round(gp.nominalGoal * 100)));
  const [nominalLaunch, setNominalLaunch] = useState(
    String(Math.round(gp.nominalLaunch * 100))
  );
  const [minimumDistance, setMinimumDistance] = useState(String(gp.minimumDistance / 1000));
  const [useLeading, setUseLeading] = useState(gp.useLeading);
  const [useArrival, setUseArrival] = useState(gp.useArrival);
  const [useDifficulty, setUseDifficulty] = useState(gp.useDistanceDifficulty ?? true);
  const [leadingFormula, setLeadingFormula] = useState<"weighted" | "classic">(
    gp.leadingFormula ?? "weighted"
  );
  const [distanceOrigin, setDistanceOrigin] = useState<"takeoff" | "start">(
    gp.distanceOrigin ?? "takeoff"
  );
  const [jtgFactor, setJtgFactor] = useState(String(gp.jumpTheGunFactor ?? 2));
  const [jtgMax, setJtgMax] = useState(String(gp.jumpTheGunMaxSeconds ?? 300));

  const [saving, setSaving] = useState(false);

  /**
   * Reset the Advanced (GAP) fields to the official CIVL GAP defaults for the
   * currently-selected category (issue #343). Nominal distance resets to
   * "auto" (blank). Leaves the non-scoring fields (name, classes, etc.)
   * untouched; nothing is saved until the admin submits.
   */
  function resetToDefaults() {
    const d = defaultsFor(category);
    setNominalDistance("");
    setNominalTime(String(Math.round(d.nominalTime / 60)));
    setNominalGoal(String(Math.round(d.nominalGoal * 100)));
    setNominalLaunch(String(Math.round(d.nominalLaunch * 100)));
    setMinimumDistance(String(d.minimumDistance / 1000));
    setUseLeading(d.useLeading);
    setUseArrival(d.useArrival);
    setUseDifficulty(d.useDistanceDifficulty);
    setLeadingFormula(d.leadingFormula);
    setDistanceOrigin(d.distanceOrigin);
    setJtgFactor(String(d.jumpTheGunFactor));
    setJtgMax(String(d.jumpTheGunMaxSeconds));
  }

  // Live class list for the default-class dropdown.
  const classes = pilotClassesText
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Mirror the vanilla <select>: when the chosen default disappears from the
  // class list, fall back to the first option.
  const effectiveDefault = classes.includes(defaultClass) ? defaultClass : (classes[0] ?? "");

  async function deleteComp() {
    const confirmed = await confirm({
      title: "Delete this competition?",
      message: "All its tasks and tracks will be deleted. This cannot be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const res = await api.api.comp[":comp_id"].$delete({ param: { comp_id: compId } });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to delete competition");
        return;
      }
      navigate("/comp");
    } catch {
      toast.error("Network error. Please try again.");
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();

    const pilotClasses = classes;
    const adminEmails = adminsText
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    if (pilotClasses.length === 0) {
      toast.warning("At least one pilot class is required");
      return;
    }
    if (adminEmails.length === 0) {
      toast.warning("At least one admin email is required");
      return;
    }

    // Build GAP scoring parameters. Scoring class follows the comp category.
    // nominalDistance is null when blank so the scorer auto-computes it per task.
    const parseField = (value: string, fallback: number) => {
      const v = parseFloat(value);
      return Number.isNaN(v) ? fallback : v;
    };
    const nominalDistanceKm = parseFloat(nominalDistance);
    const gapParams = {
      scoring: (category === "pg" ? "PG" : "HG") as "PG" | "HG",
      nominalDistance: Number.isNaN(nominalDistanceKm) ? null : nominalDistanceKm * 1000,
      nominalTime: parseField(nominalTime, 90) * 60,
      nominalGoal: parseField(nominalGoal, 20) / 100,
      nominalLaunch: parseField(nominalLaunch, 96) / 100,
      minimumDistance: parseField(minimumDistance, 5) * 1000,
      useLeading,
      useArrival,
      leadingFormula,
      distanceOrigin,
      useDistanceDifficulty: useDifficulty,
      jumpTheGunFactor: parseField(jtgFactor, 2),
      jumpTheGunMaxSeconds: parseField(jtgMax, 300),
    };

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].$patch({
        param: { comp_id: compId },
        json: {
          name: name.trim(),
          category,
          pilot_classes: pilotClasses,
          default_pilot_class: effectiveDefault,
          close_date: closeDate || null,
          test,
          timezone: timezone === "auto" ? null : timezone,
          open_igc_upload: openUpload,
          admin_emails: adminEmails,
          gap_params: gapParams,
          scoring_format: scoringFormat,
        },
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to update competition");
        return;
      }

      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Competition Settings</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={ids.name}>Name</FieldLabel>
            <Input
              id={ids.name}
              required
              maxLength={128}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <FieldSet>
            <FieldLegend variant="label">Category</FieldLegend>
            <RadioGroup
              value={category}
              onValueChange={(v) => setCategory(v as "hg" | "pg")}
              className="flex flex-row gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="hg" id={ids.hg} />
                <Label htmlFor={ids.hg} className="font-normal">
                  HG
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="pg" id={ids.pg} />
                <Label htmlFor={ids.pg} className="font-normal">
                  PG
                </Label>
              </div>
            </RadioGroup>
          </FieldSet>

          <Field>
            <FieldLabel htmlFor={ids.pilotClasses}>Pilot Classes</FieldLabel>
            <Input
              id={ids.pilotClasses}
              placeholder="open, sport, floater"
              value={pilotClassesText}
              onChange={(e) => setPilotClassesText(e.target.value)}
            />
            <FieldDescription>Comma-separated class names</FieldDescription>
          </Field>

          <div>
            <h3 className="mb-1.5 text-sm font-medium">Default Pilot Class</h3>
            <SimpleSelect
              value={effectiveDefault}
              onChange={(v) => setDefaultClass(v)}
              options={classes.map((cls) => ({ value: cls, label: cls }))}
              ariaLabel="Default pilot class"
            />
            <p className="mt-1 text-sm text-muted-foreground">
              Assigned to auto-registered pilots
            </p>
          </div>

          <Field>
            <FieldLabel htmlFor={ids.closeDate}>Close Date</FieldLabel>
            <Input
              id={ids.closeDate}
              type="date"
              value={closeDate}
              onChange={(e) => setCloseDate(e.target.value)}
            />
            <FieldDescription>
              After this date, track submissions are rejected. Leave empty for open-ended.
            </FieldDescription>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => setCloseDate("")}
            >
              Clear
            </Button>
          </Field>

          <div>
            <h3 className="mb-1.5 text-sm font-medium">Timezone</h3>
            <SearchableSelect
              value={timezone}
              onChange={setTimezone}
              options={timezoneOptions(comp.timezone)}
              ariaLabel="Competition timezone"
              placeholder="Type to search, e.g. Melbourne"
            />
            <p className="mt-1 text-sm text-muted-foreground">
              Comp-local zone for displaying times (start gates, replay clock, score
              narratives). Auto derives it from the task location. Scoring runs on UTC
              and is unaffected.
            </p>
          </div>

          <CheckboxField
            checked={test}
            onChange={setTest}
            label="Test competition (only visible to admins)"
          />
          <CheckboxField
            checked={openUpload}
            onChange={setOpenUpload}
            label="Let registered pilots record flights and statuses for each other"
            hint="Covers uploading IGC tracks, recording manual flights, and setting pilot statuses (Absent / Did Not Fly). Admins can always do these regardless of this setting."
          />

          <div>
            <h3 className="mb-1.5 text-sm font-medium">Scoring format</h3>
            <SimpleSelect
              value={scoringFormat}
              onChange={(v) => setScoringFormat(v as ScoringFormat)}
              options={[
                { value: "gap", label: "GAP — race to goal / elapsed time" },
                { value: "open_distance", label: "Open distance — fly as far as possible" },
              ]}
              ariaLabel="Scoring format"
            />
            <p className="mt-1 text-sm text-muted-foreground">
              Open distance scores metres flown from the take-off exit; each task has a
              single Takeoff turnpoint and no goal.
            </p>
          </div>

          {/* GAP parameters only apply to GAP scoring; hide them for open distance.
              They're walled off behind an Advanced disclosure (issue #343): a new
              comp already starts from the official CIVL GAP defaults for its
              category, so organisers should rarely need to open this. */}
          {scoringFormat !== "open_distance" ? (
            <details className="rounded-lg border border-border bg-muted/30 open:bg-transparent [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
                <span>Advanced scoring settings</span>
                <span aria-hidden className="text-muted-foreground">
                  GAP parameters
                </span>
              </summary>
              <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
                <div
                  role="note"
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-muted-foreground"
                >
                  <strong className="font-medium text-foreground">
                    These are the official CIVL GAP defaults for your competition
                    category.
                  </strong>{" "}
                  Changing them will make your scores differ from a standard
                  FAI&nbsp;/&nbsp;AirScore result. Only edit these if your competition
                  runs under local rules (e.g. SAFA) that specify different values, or
                  you have a specific technical reason.
                </div>
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm text-muted-foreground">
                    Competition-wide scoring constants. The scoring class (HG/PG) follows the
                    Category above.{" "}
                    <a
                      className="underline underline-offset-4"
                      href={`/scoring/gap#defaults-${category}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      How does GAP scoring work?
                    </a>
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={resetToDefaults}
                  >
                    Reset to defaults
                  </Button>
                </div>
              <Field>
                <FieldLabel htmlFor={ids.nominalDistance}>Nominal distance (km)</FieldLabel>
                <Input
                  id={ids.nominalDistance}
                  type="number"
                  min={0}
                  step={1}
                  placeholder="auto"
                  value={nominalDistance}
                  onChange={(e) => setNominalDistance(e.target.value)}
                />
                <FieldDescription>Blank = auto (70% of task)</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.nominalTime}>Nominal time (min)</FieldLabel>
                <Input
                  id={ids.nominalTime}
                  type="number"
                  min={0}
                  step={1}
                  value={nominalTime}
                  onChange={(e) => setNominalTime(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.nominalGoal}>Nominal goal (%)</FieldLabel>
                <Input
                  id={ids.nominalGoal}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={nominalGoal}
                  onChange={(e) => setNominalGoal(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.nominalLaunch}>Nominal launch (%)</FieldLabel>
                <Input
                  id={ids.nominalLaunch}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={nominalLaunch}
                  onChange={(e) => setNominalLaunch(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.minimumDistance}>Minimum distance (km)</FieldLabel>
                <Input
                  id={ids.minimumDistance}
                  type="number"
                  min={0}
                  step={0.1}
                  value={minimumDistance}
                  onChange={(e) => setMinimumDistance(e.target.value)}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor={ids.jtgFactor}>
                  Jump-the-gun: seconds per penalty point (HG)
                </FieldLabel>
                <Input
                  id={ids.jtgFactor}
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={jtgFactor}
                  onChange={(e) => setJtgFactor(e.target.value)}
                />
                <FieldDescription>
                  FAI S7F §12.2: an HG pilot starting early loses 1 point per this many
                  seconds. Spec default 2. No effect on PG (early starts are scored
                  launch→start only).
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={ids.jtgMax}>
                  Jump-the-gun: maximum seconds early (HG)
                </FieldLabel>
                <Input
                  id={ids.jtgMax}
                  type="number"
                  min={0}
                  step={1}
                  value={jtgMax}
                  onChange={(e) => setJtgMax(e.target.value)}
                />
                <FieldDescription>
                  Starting earlier than this scores minimum distance only. Spec default 300.
                </FieldDescription>
              </Field>

              <CheckboxField
                checked={useLeading}
                onChange={setUseLeading}
                label="Leading (departure) points"
              />
              <CheckboxField
                checked={useArrival}
                onChange={setUseArrival}
                label="Arrival points (HG only)"
              />
              <CheckboxField
                checked={useDifficulty}
                onChange={setUseDifficulty}
                label="Distance difficulty (HG only)"
                hint="Splits HG distance points half linear, half difficulty (FAI S7F). No effect on PG."
              />

              <div>
                <h4 className="mb-1.5 text-sm font-medium">Leading coefficient formula</h4>
                <SimpleSelect
                  value={leadingFormula}
                  onChange={(v) => setLeadingFormula(v as "weighted" | "classic")}
                  options={[
                    { value: "weighted", label: "Weighted — GAP2020+ / current FAI S7F" },
                    { value: "classic", label: "Classic — GAP2016/2018, PWC ≤2017" },
                  ]}
                  ariaLabel="Leading coefficient formula"
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  Both match AirScore; weighted is the modern default.
                </p>
              </div>
              <div>
                <h4 className="mb-1.5 text-sm font-medium">Distance origin</h4>
                <SimpleSelect
                  value={distanceOrigin}
                  onChange={(v) => setDistanceOrigin(v as "takeoff" | "start")}
                  options={[
                    { value: "takeoff", label: "Take-off — FAI CIVL GAP / PWCA (default)" },
                    { value: "start", label: 'Start cylinder — HGFA / "Move Origin"' },
                  ]}
                  ariaLabel="Distance origin"
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  Where scored distance begins for tasks with a take-off turnpoint. "Start"
                  excludes the take-off→SSS leg.
                </p>
              </div>
              </div>
            </details>
          ) : null}

          <Field>
            <FieldLabel htmlFor={ids.adminEmails}>Admin Emails</FieldLabel>
            <Input
              id={ids.adminEmails}
              placeholder="admin1@example.com, admin2@example.com"
              value={adminsText}
              onChange={(e) => setAdminsText(e.target.value)}
            />
            <FieldDescription>Comma-separated. At least one required.</FieldDescription>
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              className="sm:mr-auto"
              onClick={() => void deleteComp()}
            >
              Delete competition
            </Button>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
