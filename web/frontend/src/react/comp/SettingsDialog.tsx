/**
 * Competition settings dialog — React port of setupSettingsDialog(), on the
 * RAC kit. Mounted only while open, so field state initialises fresh from the
 * comp on every open. Numeric GAP parameters are RAC NumberFields holding
 * numbers (NaN = blank); each falls back to its spec default on save, exactly
 * as the old string-parsing did.
 */
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Form } from "react-aria-components";
import { defaultsFor, resolveCompGapParams, resolveLeadingTimeRatio } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Label, NumberField, TextField } from "@/react/rac/field";
import { DatePicker } from "@/react/rac/date-picker";
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
import { type CompDetailData, type ScoringFormat, type SeriesScoring } from "./types";

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

/** NaN-safe read of a NumberField value, mirroring the old parse fallbacks. */
function num(value: number, fallback: number): number {
  return Number.isNaN(value) ? fallback : value;
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
  const closeDateId = useId();

  // GAP scoring parameters — fall back to the official per-category FAI
  // defaults when the comp hasn't saved any (issue #343), so the Advanced
  // section always starts from the correct official values.
  // nominalDistance stays blank when unset so the scorer auto-computes
  // it per task (70% of task distance), matching historical behavior.
  // Resolve the *effective* params the scorer uses (official per-category
  // defaults + saved overrides), so every field's initial value matches what
  // the scoreboard is computed from.
  // Strip nominalDistance (nullable "auto") before merging — the dialog keys
  // its own nominalDistance field off the stored value, and the engine type
  // wants number | undefined, not the CompGapParams number | null.
  const { nominalDistance: _gpNd, ...gpStored } = comp.gap_params ?? {};
  void _gpNd;
  const gp = resolveCompGapParams(
    comp.category === "pg" ? "pg" : "hg",
    comp.gap_params ? gpStored : null
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
  const [openRegistration, setOpenRegistration] = useState(
    comp.open_registration ?? true
  );
  // "auto" = no explicit zone: the server derives one from the task
  // location (and re-derives when saved as auto).
  const [timezone, setTimezone] = useState(comp.timezone ?? "auto");
  const [adminsText, setAdminsText] = useState(comp.admins.map((a) => a.email).join(", "));
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(
    comp.scoring_format ?? "gap"
  );
  const [seriesScoring, setSeriesScoring] = useState<SeriesScoring>(
    comp.series_scoring ?? "total"
  );
  // "" = automatic (derive 0.2/0.25 from the task count); otherwise the stored
  // discard fraction as a percentage string.
  const [ftvFactorPct, setFtvFactorPct] = useState(
    comp.ftv_factor != null ? String(Math.round(comp.ftv_factor * 100)) : ""
  );

  // Blank (NaN) = "auto" (the scorer uses 70% of each task's distance). Key
  // off the *stored* value, not the per-category default, so a comp that never
  // pinned a nominal distance shows auto — matching the documented default and
  // the scorer's auto behaviour.
  const [nominalDistance, setNominalDistance] = useState(
    comp.gap_params?.nominalDistance != null
      ? Math.round(comp.gap_params.nominalDistance / 1000)
      : NaN
  );
  const [nominalTime, setNominalTime] = useState(Math.round(gp.nominalTime / 60));
  const [minimumDistance, setMinimumDistance] = useState(gp.minimumDistance / 1000);
  const [useLeading, setUseLeading] = useState(gp.useLeading);
  const [useArrival, setUseArrival] = useState(gp.useArrival);
  const [useDifficulty, setUseDifficulty] = useState(gp.useDistanceDifficulty ?? true);
  // S7F 2026 §11 Leading Time Ratio, shown as a percentage (0–26). One
  // decimal place — the HG default is 17.5%, and whole-percent rounding
  // would silently save 18%.
  const [leadingTimeRatio, setLeadingTimeRatio] = useState(
    Math.round(resolveLeadingTimeRatio(gp) * 1000) / 10
  );
  const [distanceOrigin, setDistanceOrigin] = useState<"takeoff" | "start">(
    gp.distanceOrigin ?? "takeoff"
  );
  const [jtgFactor, setJtgFactor] = useState(gp.jumpTheGunFactor ?? 2);
  const [jtgMax, setJtgMax] = useState(gp.jumpTheGunMaxSeconds ?? 300);
  // ESS-but-not-goal (S7F 2026 §13.2), shown as a percentage of points kept.
  const [essNotGoal, setEssNotGoal] = useState(
    Math.round((gp.essNotGoalFactor ?? 0.8) * 100)
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
    setNominalDistance(NaN);
    setNominalTime(Math.round(d.nominalTime / 60));
    setMinimumDistance(d.minimumDistance / 1000);
    setUseLeading(d.useLeading);
    setUseArrival(d.useArrival);
    setUseDifficulty(d.useDistanceDifficulty);
    setLeadingTimeRatio(Math.round(resolveLeadingTimeRatio(d) * 1000) / 10);
    setDistanceOrigin(d.distanceOrigin);
    setJtgFactor(d.jumpTheGunFactor);
    setJtgMax(d.jumpTheGunMaxSeconds);
    setEssNotGoal(Math.round(d.essNotGoalFactor * 100));
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

  async function save() {
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
    const gapParams = {
      scoring: (category === "pg" ? "PG" : "HG") as "PG" | "HG",
      nominalDistance: Number.isNaN(nominalDistance) ? null : nominalDistance * 1000,
      nominalTime: num(nominalTime, 90) * 60,
      minimumDistance: num(minimumDistance, 5) * 1000,
      useLeading,
      useArrival,
      leadingTimeRatio:
        num(leadingTimeRatio, category === "pg" ? 26 : 17.5) / 100,
      distanceOrigin,
      useDistanceDifficulty: useDifficulty,
      jumpTheGunFactor: num(jtgFactor, 2),
      jumpTheGunMaxSeconds: num(jtgMax, 300),
      essNotGoalFactor: num(essNotGoal, 80) / 100,
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
          open_registration: openRegistration,
          admin_emails: adminEmails,
          gap_params: gapParams,
          scoring_format: scoringFormat,
          // FTV is a GAP-only aggregation; open-distance comps sum tasks.
          series_scoring: scoringFormat === "gap" ? seriesScoring : "total",
          ftv_factor:
            scoringFormat === "gap" && seriesScoring === "ftv" && ftvFactorPct
              ? Number(ftvFactorPct) / 100
              : null,
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
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-2xl"
    >
      <Dialog>
        <DialogHeader>
          <DialogTitle>Competition Settings</DialogTitle>
        </DialogHeader>
        <Form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-6"
        >
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

          <div className="flex flex-col gap-2">
            <Label id={closeDateId}>Close Date</Label>
            <DatePicker
              clearable
              aria-labelledby={closeDateId}
              value={closeDate}
              onChange={setCloseDate}
            />
            <p className="text-xs text-muted-foreground">
              After this date, track submissions are rejected. Leave empty for open-ended.
            </p>
          </div>

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
            checked={openRegistration}
            onChange={setOpenRegistration}
            label="Let pilots register themselves by submitting a track"
            hint="Off, only admins add pilots. Pilots you registered can always submit."
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

          {/* Series (multi-task) scoring — how per-task scores combine into
              competition scores. FTV is a GAP-only aggregation (S7F §16). */}
          {scoringFormat === "gap" ? (
            <div>
              <h3 className="mb-1.5 text-sm font-medium">Series scoring</h3>
              <SimpleSelect
                value={seriesScoring}
                onChange={(v) => setSeriesScoring(v as SeriesScoring)}
                options={[
                  { value: "total", label: "Sum of task scores" },
                  { value: "ftv", label: "FTV — Fixed Total Validity" },
                ]}
                ariaLabel="Series scoring"
              />
              <p className="mt-1 text-sm text-muted-foreground">
                FTV (S7F §16) scores each pilot on their best tasks, discarding a
                fixed fraction of the total validity — the paragliding norm. Sum of
                task scores is the simple total.
              </p>
              {seriesScoring === "ftv" ? (
                <div className="mt-2">
                  <SimpleSelect
                    value={ftvFactorPct}
                    onChange={setFtvFactorPct}
                    options={[
                      { value: "", label: "Automatic (20% for ≤6 tasks, 25% for ≥7)" },
                      { value: "20", label: "Discard 20%" },
                      { value: "25", label: "Discard 25%" },
                    ]}
                    ariaLabel="FTV discard fraction"
                  />
                </div>
              ) : null}
            </div>
          ) : null}

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
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onPress={resetToDefaults}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <NumberField
                  label="Nominal distance (km)"
                  minValue={0}
                  step={1}
                  formatOptions={{ useGrouping: false }}
                  placeholder="auto"
                  value={nominalDistance}
                  onChange={setNominalDistance}
                  description="Blank = auto (70% of task)"
                />
                <NumberField
                  label="Nominal time (min)"
                  minValue={0}
                  step={1}
                  formatOptions={{ useGrouping: false }}
                  value={nominalTime}
                  onChange={setNominalTime}
                />
                <NumberField
                  label="Minimum distance (km)"
                  minValue={0}
                  step={0.1}
                  formatOptions={{ useGrouping: false }}
                  value={minimumDistance}
                  onChange={setMinimumDistance}
                />

                <NumberField
                  label="Jump-the-gun: seconds per penalty point (HG)"
                  minValue={0.1}
                  step={0.1}
                  formatOptions={{ useGrouping: false }}
                  value={jtgFactor}
                  onChange={setJtgFactor}
                  description="FAI S7F §13.3: an HG pilot starting early loses 1 point per this many seconds. Spec default 2. No effect on PG (early starts are scored launch→start only)."
                />
                <NumberField
                  label="Jump-the-gun: maximum seconds early (HG)"
                  minValue={0}
                  step={1}
                  formatOptions={{ useGrouping: false }}
                  value={jtgMax}
                  onChange={setJtgMax}
                  description="Starting earlier than this scores minimum distance only. Spec default 300."
                />
                <NumberField
                  label="ESS but not goal: points kept (%, HG)"
                  minValue={0}
                  maxValue={100}
                  step={1}
                  formatOptions={{ useGrouping: false }}
                  value={essNotGoal}
                  onChange={setEssNotGoal}
                  description="FAI S7F §13.2: an HG pilot who reaches ESS but lands before goal keeps this share of their time and arrival points. Spec default 80. No effect on PG (the spec fixes it at 0 — no goal, no time points)."
                />

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

                <NumberField
                  label="Leading-time ratio (%)"
                  minValue={0}
                  maxValue={26}
                  step={0.5}
                  formatOptions={{ useGrouping: false }}
                  value={leadingTimeRatio}
                  onChange={setLeadingTimeRatio}
                  description={
                    category === "pg"
                      ? "FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 26%). The rest goes to time. When nobody makes goal, all the non-distance weight goes to leading."
                      : "FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 17.5%). The rest goes to time and arrival."
                  }
                />
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

          <TextField
            label="Admin Emails"
            placeholder="admin1@example.com, admin2@example.com"
            value={adminsText}
            onChange={setAdminsText}
            description="Comma-separated. At least one required."
          />

          <DialogFooter>
            <Button
              variant="destructive"
              className="sm:mr-auto"
              onPress={() => void deleteComp()}
            >
              Delete competition
            </Button>
            <Button slot="close" variant="outline">
              Cancel
            </Button>
            <Button type="submit" isPending={saving} pendingLabel="Saving">
              Save
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
