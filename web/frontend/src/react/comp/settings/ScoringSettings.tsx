/**
 * Scoring settings sub-page: scoring format, series scoring (and FTV discard
 * fraction), and the Advanced GAP parameters disclosure. Fields, FAI prose
 * and behaviour carried over verbatim from the old settings dialog, with one
 * deliberate change: an open-distance comp omits `gap_params` from its PATCH
 * entirely rather than sending parameters the format doesn't use.
 *
 * The GAP defaults (and the reset button) key off the comp's SAVED wing —
 * Wing lives on the General sub-page now, and the server re-syncs the stored
 * `gap_params.scoring` whenever the wing later changes.
 */
import { useRef, useState } from "react";
import {
  defaultsFor,
  resolveCompGapParams,
  resolveLeadingTimeRatio,
} from "@glidecomp/engine";
import { SettingsPage } from "@/react/components/SettingsPage";
import { SettingsForm } from "@/react/components/SettingsForm";
import { Button } from "@/react/rac/button";
import { NumberField } from "@/react/rac/field";
import { api } from "@/comp/api";
import { toast } from "@/react/lib/toast";
import { underCompSettings } from "@/react/lib/crumbs";
import { ChoiceList } from "@/react/rac/choice-list";
import { SwitchField, SwitchList } from "@/react/rac/switch";
import type { ScoringFormat, SeriesScoring } from "../types";
import type { SettingsGroupProps } from "./CompSettingsIndex";

/** NaN-safe read of a NumberField value, mirroring the old parse fallbacks. */
function num(value: number, fallback: number): number {
  return Number.isNaN(value) ? fallback : value;
}

export function ScoringSettings({ compId, comp, onSaved }: SettingsGroupProps) {
  const wing: "hg" | "pg" = comp.category === "pg" ? "pg" : "hg";

  // GAP scoring parameters — fall back to the official per-category FAI
  // defaults when the comp hasn't saved any (issue #343), so the Advanced
  // section always starts from the correct official values.
  // nominalDistance stays blank when unset so the scorer auto-computes
  // it per task (70% of task distance), matching historical behavior.
  // Resolve the *effective* params the scorer uses (official per-category
  // defaults + saved overrides), so every field's initial value matches what
  // the scoreboard is computed from.
  // Strip nominalDistance (nullable "auto") before merging — the page keys
  // its own nominalDistance field off the stored value, and the engine type
  // wants number | undefined, not the CompGapParams number | null.
  const { nominalDistance: _gpNd, ...gpStored } = comp.gap_params ?? {};
  void _gpNd;
  const gp = resolveCompGapParams(wing, comp.gap_params ? gpStored : null);

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

  // Dirty = any field differs from its first-render value. One snapshot
  // rather than fourteen comparisons; NaN survives the JSON round-trip as
  // null on both sides, so blank-vs-blank compares equal.
  const snapshot = {
    scoringFormat,
    seriesScoring,
    ftvFactorPct,
    nominalDistance,
    nominalTime,
    minimumDistance,
    useLeading,
    useArrival,
    useDifficulty,
    leadingTimeRatio,
    distanceOrigin,
    jtgFactor,
    jtgMax,
    essNotGoal,
  };
  const initialRef = useRef<string | null>(null);
  if (initialRef.current === null) initialRef.current = JSON.stringify(snapshot);
  const dirty = JSON.stringify(snapshot) !== initialRef.current;

  /**
   * Reset the Advanced (GAP) fields to the official CIVL GAP defaults for the
   * comp's wing (issue #343). Nominal distance resets to "auto" (blank).
   * Nothing is saved until the admin submits.
   */
  function resetToDefaults() {
    const d = defaultsFor(wing);
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

  async function save() {
    // Build GAP scoring parameters. Scoring class follows the comp's wing.
    // nominalDistance is null when blank so the scorer auto-computes it per task.
    const gapParams = {
      scoring: (wing === "pg" ? "PG" : "HG") as "PG" | "HG",
      nominalDistance: Number.isNaN(nominalDistance) ? null : nominalDistance * 1000,
      nominalTime: num(nominalTime, 90) * 60,
      minimumDistance: num(minimumDistance, 5) * 1000,
      useLeading,
      useArrival,
      leadingTimeRatio: num(leadingTimeRatio, wing === "pg" ? 26 : 17.5) / 100,
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
          scoring_format: scoringFormat,
          // FTV is a GAP-only aggregation; open-distance comps sum tasks.
          series_scoring: scoringFormat === "gap" ? seriesScoring : "total",
          ftv_factor:
            scoringFormat === "gap" && seriesScoring === "ftv" && ftvFactorPct
              ? Number(ftvFactorPct) / 100
              : null,
          // GAP parameters only exist for GAP scoring; an open-distance comp
          // omits them so nothing the format doesn't use gets written.
          ...(scoringFormat !== "open_distance" ? { gap_params: gapParams } : {}),
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
    <SettingsPage crumbs={underCompSettings(compId, comp.name)} title="Scoring">
      <SettingsForm onSave={save} saving={saving} dirty={dirty}>
        <ChoiceList
          label="Scoring format"
          value={scoringFormat}
          onChange={(v) => setScoringFormat(v as ScoringFormat)}
          options={[
            { value: "gap", label: "GAP — race to goal / elapsed time" },
            { value: "open_distance", label: "Open distance — fly as far as possible" },
          ]}
          description="Open distance scores metres flown from the take-off exit; each task has a single Takeoff turnpoint and no goal."
        />

        {/* Series (multi-task) scoring — how per-task scores combine into
            competition scores. FTV is a GAP-only aggregation (S7F §16). */}
        {scoringFormat === "gap" ? (
          <div className="flex flex-col gap-2">
            <ChoiceList
              label="Series scoring"
              value={seriesScoring}
              onChange={(v) => setSeriesScoring(v as SeriesScoring)}
              options={[
                { value: "total", label: "Sum of task scores" },
                { value: "ftv", label: "FTV — Fixed Total Validity" },
              ]}
              description="FTV (S7F §16) scores each pilot on their best tasks, discarding a fixed fraction of the total validity — the paragliding norm. Sum of task scores is the simple total."
            />
            {seriesScoring === "ftv" ? (
              <ChoiceList
                label="FTV discard fraction"
                value={ftvFactorPct}
                onChange={setFtvFactorPct}
                options={[
                  { value: "", label: "Automatic (20% for ≤6 tasks, 25% for ≥7)" },
                  { value: "20", label: "Discard 20%" },
                  { value: "25", label: "Discard 25%" },
                ]}
              />
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
                  comp's Wing (in General settings).{" "}
                  <a
                    className="underline underline-offset-4"
                    href={`/scoring/gap#defaults-${wing}`}
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

              <SwitchList>
                <SwitchField
                  checked={useLeading}
                  onChange={setUseLeading}
                  label="Leading (departure) points"
                />
                <SwitchField
                  checked={useArrival}
                  onChange={setUseArrival}
                  label="Arrival points (HG only)"
                />
                <SwitchField
                  checked={useDifficulty}
                  onChange={setUseDifficulty}
                  label="Distance difficulty (HG only)"
                  hint="Splits HG distance points half linear, half difficulty (FAI S7F). No effect on PG."
                />
              </SwitchList>

              <NumberField
                label="Leading-time ratio (%)"
                minValue={0}
                maxValue={26}
                step={0.5}
                formatOptions={{ useGrouping: false }}
                value={leadingTimeRatio}
                onChange={setLeadingTimeRatio}
                description={
                  wing === "pg"
                    ? "FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 26%). The rest goes to time. When nobody makes goal, all the non-distance weight goes to leading."
                    : "FAI S7F §11: the % of the non-distance weight allocated to leading (0–26%, spec default 17.5%). The rest goes to time and arrival."
                }
              />
              <ChoiceList
                label="Distance origin"
                value={distanceOrigin}
                onChange={(v) => setDistanceOrigin(v as "takeoff" | "start")}
                options={[
                  { value: "takeoff", label: "Take-off — FAI CIVL GAP / PWCA (default)" },
                  { value: "start", label: 'Start cylinder — HGFA / "Move Origin"' },
                ]}
                description='Where scored distance begins for tasks with a take-off turnpoint. "Start" excludes the take-off→SSS leg.'
              />
            </div>
          </details>
        ) : null}
      </SettingsForm>
    </SettingsPage>
  );
}
