/**
 * Competition settings dialog — React port of setupSettingsDialog().
 * Mounted only while open, so field state initialises fresh from the comp
 * on every open.
 */
import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { defaultsFor, resolveCompGapParams, resolveTimePointsExponent } from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { DatePicker } from "@/react/ui/date-picker";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import {
  CategoryField,
  CheckboxField,
  NameField,
  PilotClassesField,
  SearchableSelect,
  SimpleSelect,
  TestCompField,
} from "./fields";
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
    closeDate: useId(),
    adminEmails: useId(),
    nominalDistance: useId(),
    nominalTime: useId(),
    nominalGoal: useId(),
    nominalLaunch: useId(),
    minimumDistance: useId(),
    jtgFactor: useId(),
    jtgMax: useId(),
    leadingTimeRatio: useId(),
    essNotGoal: useId(),
    scoreBack: useId(),
  };

  // GAP scoring parameters — fall back to the official per-category FAI
  // defaults when the comp hasn't saved any (issue #343), so the Advanced
  // section always starts from the correct official values.
  // nominalDistance stays blank when unset so the scorer auto-computes
  // it per task (70% of task distance), matching historical behavior.
  // Resolve the *effective* params the scorer uses (official per-category
  // defaults + saved overrides, plus the date-based PG leading-weight default
  // from the comp's creation time — issue #257), so every field's initial
  // value matches what the scoreboard is computed from.
  const gpCreatedAtMs = Date.parse(comp.creation_date);
  // Strip nominalDistance (nullable "auto") before merging — the dialog keys
  // its own nominalDistance field off the stored value, and the engine type
  // wants number | undefined, not the CompGapParams number | null.
  const { nominalDistance: _gpNd, ...gpStored } = comp.gap_params ?? {};
  void _gpNd;
  const gp = resolveCompGapParams(
    comp.category === "pg" ? "pg" : "hg",
    comp.gap_params ? gpStored : null,
    Number.isNaN(gpCreatedAtMs) ? null : gpCreatedAtMs
  );

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
  // Leading-weight generation (PG only; issue #257). `gp` is the effective
  // params (resolveCompGapParams with the comp's creation date), so a new PG
  // comp shows 's7f2024' and an older one 'gap2020' — matching the scorer.
  const [leadingWeightFormula, setLeadingWeightFormula] = useState<"gap2020" | "s7f2024">(
    gp.leadingWeightFormula ?? "gap2020"
  );
  const [leadingTimeRatio, setLeadingTimeRatio] = useState(
    String(Math.round((gp.leadingTimeRatio ?? 0.26) * 100))
  );
  // Time-points exponent (S7F §11.2), decoupled from the leading formula
  // (issue #258). A saved comp that predates the split keeps the exponent its
  // leadingFormula historically implied (resolveTimePointsExponent).
  const [timePointsExponent, setTimePointsExponent] = useState<"5/6" | "2/3">(
    resolveTimePointsExponent(gp)
  );
  const [distanceOrigin, setDistanceOrigin] = useState<"takeoff" | "start">(
    gp.distanceOrigin ?? "takeoff"
  );
  const [jtgFactor, setJtgFactor] = useState(String(gp.jumpTheGunFactor ?? 2));
  const [jtgMax, setJtgMax] = useState(String(gp.jumpTheGunMaxSeconds ?? 300));
  // ESS-but-not-goal (S7F §12.1), shown as a percentage of points kept.
  const [essNotGoal, setEssNotGoal] = useState(
    String(Math.round((gp.essNotGoalFactor ?? 0.8) * 100))
  );
  // PG score-back time (S7F §5.6, §12.3.1), shown in minutes.
  const [scoreBack, setScoreBack] = useState(
    String(Math.round((gp.scoreBackTime ?? 300) / 60))
  );

  const [saving, setSaving] = useState(false);

  /**
   * Reset the Advanced (GAP) fields to the official CIVL GAP defaults for the
   * currently-selected category (issue #343). Nominal distance resets to
   * "auto" (blank). Leaves the non-scoring fields (name, classes, etc.)
   * untouched; nothing is saved until the admin submits.
   */
  function resetToDefaults() {
    const d = defaultsFor(category);
    // The PG leading-weight default is date-based (issue #257): reset to what a
    // comp of this age would default to — 's7f2024' for one created on/after
    // the cutoff, 'gap2020' for an older one — not the raw engine baseline.
    const resolved = resolveCompGapParams(
      category,
      null,
      Number.isNaN(gpCreatedAtMs) ? null : gpCreatedAtMs
    );
    setNominalDistance("");
    setNominalTime(String(Math.round(d.nominalTime / 60)));
    setNominalGoal(String(Math.round(d.nominalGoal * 100)));
    setNominalLaunch(String(Math.round(d.nominalLaunch * 100)));
    setMinimumDistance(String(d.minimumDistance / 1000));
    setUseLeading(d.useLeading);
    setUseArrival(d.useArrival);
    setUseDifficulty(d.useDistanceDifficulty);
    setLeadingFormula(d.leadingFormula);
    setLeadingWeightFormula(resolved.leadingWeightFormula);
    setLeadingTimeRatio(String(Math.round(d.leadingTimeRatio * 100)));
    setTimePointsExponent(resolveTimePointsExponent(d));
    setDistanceOrigin(d.distanceOrigin);
    setJtgFactor(String(d.jumpTheGunFactor));
    setJtgMax(String(d.jumpTheGunMaxSeconds));
    setEssNotGoal(String(Math.round(d.essNotGoalFactor * 100)));
    setScoreBack(String(Math.round(d.scoreBackTime / 60)));
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
      leadingWeightFormula,
      leadingTimeRatio: parseField(leadingTimeRatio, 26) / 100,
      timePointsExponent,
      distanceOrigin,
      useDistanceDifficulty: useDifficulty,
      jumpTheGunFactor: parseField(jtgFactor, 2),
      jumpTheGunMaxSeconds: parseField(jtgMax, 300),
      essNotGoalFactor: parseField(essNotGoal, 80) / 100,
      scoreBackTime: parseField(scoreBack, 5) * 60,
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
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-6">
          <NameField value={name} onChange={setName} />

          <CategoryField value={category} onChange={setCategory} />

          <PilotClassesField value={pilotClassesText} onChange={setPilotClassesText} wing={category} />

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
            <FieldLabel id={ids.closeDate}>Close Date</FieldLabel>
            <DatePicker
              clearable
              aria-labelledby={ids.closeDate}
              value={closeDate}
              onChange={setCloseDate}
            />
            <FieldDescription>
              After this date, track submissions are rejected. Leave empty for open-ended.
            </FieldDescription>
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

          <TestCompField checked={test} onChange={setTest} />
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
              <div className="flex flex-col gap-6 border-t border-border px-4 py-4">
                <div
                  role="note"
                  className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-muted-foreground"
                >
                  <strong className="font-medium text-foreground">
                    These are the official CIVL GAP defaults for your competition
                    wing.
                  </strong>{" "}
                  Changing them will make your scores differ from a standard
                  FAI&nbsp;/&nbsp;AirScore result. Only edit these if your competition
                  runs under local rules (e.g. SAFA) that specify different values, or
                  you have a specific technical reason.
                </div>
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm text-muted-foreground">
                    Competition-wide scoring constants. The scoring class (HG/PG) follows the
                    Wing above.{" "}
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
              <Field>
                <FieldLabel htmlFor={ids.essNotGoal}>
                  ESS but not goal: points kept (%, HG)
                </FieldLabel>
                <Input
                  id={ids.essNotGoal}
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={essNotGoal}
                  onChange={(e) => setEssNotGoal(e.target.value)}
                />
                <FieldDescription>
                  FAI S7F §12.1: an HG pilot who reaches ESS but lands before goal keeps
                  this share of their time and arrival points. Spec default 80. No effect
                  on PG (the spec fixes it at 0 — no goal, no time points).
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor={ids.scoreBack}>
                  Score-back time (min, PG stopped tasks)
                </FieldLabel>
                <Input
                  id={ids.scoreBack}
                  type="number"
                  min={0}
                  max={60}
                  step={1}
                  value={scoreBack}
                  onChange={(e) => setScoreBack(e.target.value)}
                />
                <FieldDescription>
                  FAI S7F §5.6, §12.3.1: when a PG task is stopped, the task stop time is
                  the stop announcement minus this. Spec default 5 minutes. No effect on HG
                  (scored back one start-gate interval, or 15 minutes with a single gate).
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
                    { value: "weighted", label: "Weighted — GAP2020+ / S7F paragliding" },
                    { value: "classic", label: "Classic — S7F hang gliding / GAP2016/2018" },
                  ]}
                  ariaLabel="Leading coefficient formula"
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  The leading-points envelope (S7F §11.3.1). The 2024 spec pairs hang
                  gliding with classic and paragliding with weighted; both match AirScore.
                </p>
              </div>
              <div>
                <h4 className="mb-1.5 text-sm font-medium">Time points exponent</h4>
                <SimpleSelect
                  value={timePointsExponent}
                  onChange={(v) => setTimePointsExponent(v as "5/6" | "2/3")}
                  options={[
                    { value: "5/6", label: "5⁄6 — current FAI S7F (both sports)" },
                    { value: "2/3", label: "2⁄3 — older GAP2016/2018 curve" },
                  ]}
                  ariaLabel="Time points exponent"
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  The speed-fraction exponent (S7F §11.2), set independently of the leading
                  formula. 5⁄6 is the current spec for both sports; 2⁄3 is slightly more
                  generous.
                </p>
              </div>
              {category === "pg" ? (
                <div>
                  <h4 className="mb-1.5 text-sm font-medium">
                    Paragliding leading weight
                  </h4>
                  <SimpleSelect
                    value={leadingWeightFormula}
                    onChange={(v) => setLeadingWeightFormula(v as "gap2020" | "s7f2024")}
                    options={[
                      { value: "gap2020", label: "GAP2020 — GAP2016/2018 weights (default)" },
                      { value: "s7f2024", label: "S7F 2024 — LeadingTimeRatio (§10)" },
                    ]}
                    ariaLabel="Paragliding leading weight formula"
                  />
                  <p className="mt-1 text-sm text-muted-foreground">
                    How much of the non-distance weight goes to leading vs time.
                    GAP2020 gives leading 35% (and 0.1 × BestDist/TaskDist of the total
                    when nobody makes goal); S7F 2024 uses the LeadingTimeRatio below
                    (and all of the non-distance weight when nobody makes goal).
                    Hang-gliding is unaffected.
                  </p>
                  {leadingWeightFormula === "s7f2024" ? (
                    <Field className="mt-3">
                      <FieldLabel htmlFor={ids.leadingTimeRatio}>
                        Leading-time ratio (%)
                      </FieldLabel>
                      <Input
                        id={ids.leadingTimeRatio}
                        type="number"
                        min={0}
                        max={50}
                        step={1}
                        value={leadingTimeRatio}
                        onChange={(e) => setLeadingTimeRatio(e.target.value)}
                      />
                      <FieldDescription>
                        FAI S7F §10: the % of the non-distance weight allocated to
                        leading when someone makes goal (0–50%, spec default 26%). The
                        rest goes to time.
                      </FieldDescription>
                    </Field>
                  ) : null}
                </div>
              ) : null}
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
