/**
 * Competition settings dialog — React port of setupSettingsDialog().
 * Mounted only while open, so field state initialises fresh from the comp
 * on every open.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { DEFAULT_GAP_PARAMETERS } from "@glidecomp/engine";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { CheckboxField, SimpleSelect } from "./fields";
import {
  slugifyStatusKey,
  type CompDetailData,
  type PilotStatusConfig,
  type ScoringFormat,
} from "./types";

interface StatusRowState {
  /** Stable React key for the row. */
  id: number;
  /** Original status key ("" for rows added in this dialog session). */
  key: string;
  label: string;
  on_track_upload: PilotStatusConfig["on_track_upload"];
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

  // GAP scoring parameters — fall back to engine defaults when unset.
  // nominalDistance stays blank when unset so the scorer auto-computes
  // it per task (70% of task distance), matching historical behavior.
  const gp = comp.gap_params ?? DEFAULT_GAP_PARAMETERS;

  const [name, setName] = useState(comp.name);
  const [category, setCategory] = useState<"hg" | "pg">(comp.category === "hg" ? "hg" : "pg");
  const [pilotClassesText, setPilotClassesText] = useState(comp.pilot_classes.join(", "));
  const [defaultClass, setDefaultClass] = useState(comp.default_pilot_class);
  const [closeDate, setCloseDate] = useState(
    comp.close_date ? comp.close_date.split("T")[0] : ""
  );
  const [test, setTest] = useState(comp.test);
  const [openUpload, setOpenUpload] = useState(comp.open_igc_upload ?? true);
  const [adminsText, setAdminsText] = useState(comp.admins.map((a) => a.email).join(", "));
  const [scoringFormat, setScoringFormat] = useState<ScoringFormat>(
    comp.scoring_format ?? "gap"
  );

  const [nominalDistance, setNominalDistance] = useState(
    gp.nominalDistance != null ? String(Math.round(gp.nominalDistance / 1000)) : ""
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

  const nextStatusId = useRef(0);
  const [statuses, setStatuses] = useState<StatusRowState[]>(() =>
    (comp.pilot_statuses ?? []).map((s) => ({ id: nextStatusId.current++, ...s }))
  );

  const [saving, setSaving] = useState(false);

  // Live class list for the default-class dropdown.
  const classes = pilotClassesText
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  // Mirror the vanilla <select>: when the chosen default disappears from the
  // class list, fall back to the first option.
  const effectiveDefault = classes.includes(defaultClass) ? defaultClass : (classes[0] ?? "");

  function updateStatus(id: number, patch: Partial<StatusRowState>) {
    setStatuses((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

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
    };

    // Collect status rows: skip blank labels; preserve existing keys (so the
    // server sees an update, not a remove+add pair), derive new ones from
    // the label.
    const pilotStatuses: PilotStatusConfig[] = [];
    for (const s of statuses) {
      const label = s.label.trim();
      if (!label) continue;
      const key = s.key || slugifyStatusKey(label);
      if (!key) continue;
      pilotStatuses.push({ key, label, on_track_upload: s.on_track_upload });
    }
    // Guard against duplicate keys — can happen if an admin types a new
    // label that slugifies to the same key as an existing row.
    const keySeen = new Set<string>();
    for (const s of pilotStatuses) {
      if (keySeen.has(s.key)) {
        toast.warning(`Duplicate status key "${s.key}" — rename one of the rows`);
        return;
      }
      keySeen.add(s.key);
    }

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
          open_igc_upload: openUpload,
          admin_emails: adminEmails,
          pilot_statuses: pilotStatuses,
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Competition Settings</Dialog.Title>
          <form onSubmit={(e) => void save(e)}>
            <Field.Root>
              <Field.Label>Name</Field.Label>
              <Input
                required
                maxLength={128}
                value={name}
                onValueChange={(v) => setName(v)}
              />
            </Field.Root>

            <fieldset>
              <legend>Category</legend>
              <RadioGroup
                value={category}
                onValueChange={(v) => setCategory(v as "hg" | "pg")}
              >
                <label>
                  <Radio.Root value="hg">
                    <Radio.Indicator>●</Radio.Indicator>
                  </Radio.Root>{" "}
                  HG
                </label>
                <label>
                  <Radio.Root value="pg">
                    <Radio.Indicator>●</Radio.Indicator>
                  </Radio.Root>{" "}
                  PG
                </label>
              </RadioGroup>
            </fieldset>

            <Field.Root>
              <Field.Label>Pilot Classes</Field.Label>
              <Input
                placeholder="open, sport, floater"
                value={pilotClassesText}
                onValueChange={(v) => setPilotClassesText(v)}
              />
              <Field.Description>Comma-separated class names</Field.Description>
            </Field.Root>

            <div>
              <h3>Default Pilot Class</h3>
              <SimpleSelect
                value={effectiveDefault}
                onChange={(v) => setDefaultClass(v)}
                options={classes.map((cls) => ({ value: cls, label: cls }))}
                ariaLabel="Default pilot class"
              />
              <p>Assigned to auto-registered pilots</p>
            </div>

            <Field.Root>
              <Field.Label>Close Date</Field.Label>
              <Input type="date" value={closeDate} onValueChange={(v) => setCloseDate(v)} />
              <Field.Description>
                After this date, track submissions are rejected. Leave empty for open-ended.
              </Field.Description>
              <button type="button" onClick={() => setCloseDate("")}>
                Clear
              </button>
            </Field.Root>

            <CheckboxField
              checked={test}
              onChange={setTest}
              label="Test competition (only visible to admins)"
            />
            <CheckboxField
              checked={openUpload}
              onChange={setOpenUpload}
              label="Allow registered pilots to upload IGC files for each other"
              hint="Admins can always upload regardless of this setting."
            />

            <div>
              <h3>Scoring format</h3>
              <SimpleSelect
                value={scoringFormat}
                onChange={(v) => setScoringFormat(v as ScoringFormat)}
                options={[
                  { value: "gap", label: "GAP — race to goal / elapsed time" },
                  { value: "open_distance", label: "Open distance — fly as far as possible" },
                ]}
                ariaLabel="Scoring format"
              />
              <p>
                Open distance scores metres flown from the take-off exit; each task has a
                single Takeoff turnpoint and no goal.
              </p>
            </div>

            {/* GAP parameters only apply to GAP scoring; hide them for open distance. */}
            {scoringFormat !== "open_distance" ? (
              <div>
                <h3>GAP Scoring Parameters</h3>
                <p>
                  Competition-wide scoring constants. The scoring class (HG/PG) follows the
                  Category above.{" "}
                  <a href="/scoring-gap.html" target="_blank" rel="noopener noreferrer">
                    How does GAP scoring work?
                  </a>
                </p>
                <Field.Root>
                  <Field.Label>Nominal distance (km)</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    placeholder="auto"
                    value={nominalDistance}
                    onValueChange={(v) => setNominalDistance(v)}
                  />
                  <Field.Description>Blank = auto (70% of task)</Field.Description>
                </Field.Root>
                <Field.Root>
                  <Field.Label>Nominal time (min)</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={nominalTime}
                    onValueChange={(v) => setNominalTime(v)}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Nominal goal (%)</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={nominalGoal}
                    onValueChange={(v) => setNominalGoal(v)}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Nominal launch (%)</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={nominalLaunch}
                    onValueChange={(v) => setNominalLaunch(v)}
                  />
                </Field.Root>
                <Field.Root>
                  <Field.Label>Minimum distance (km)</Field.Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.1}
                    value={minimumDistance}
                    onValueChange={(v) => setMinimumDistance(v)}
                  />
                </Field.Root>

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
                  <h4>Leading coefficient formula</h4>
                  <SimpleSelect
                    value={leadingFormula}
                    onChange={(v) => setLeadingFormula(v as "weighted" | "classic")}
                    options={[
                      { value: "weighted", label: "Weighted — GAP2020+ / current FAI S7F" },
                      { value: "classic", label: "Classic — GAP2016/2018, PWC ≤2017" },
                    ]}
                    ariaLabel="Leading coefficient formula"
                  />
                  <p>Both match AirScore; weighted is the modern default.</p>
                </div>
                <div>
                  <h4>Distance origin</h4>
                  <SimpleSelect
                    value={distanceOrigin}
                    onChange={(v) => setDistanceOrigin(v as "takeoff" | "start")}
                    options={[
                      { value: "takeoff", label: "Take-off — FAI CIVL GAP / PWCA (default)" },
                      { value: "start", label: 'Start cylinder — HGFA / "Move Origin"' },
                    ]}
                    ariaLabel="Distance origin"
                  />
                  <p>
                    Where scored distance begins for tasks with a take-off turnpoint. "Start"
                    excludes the take-off→SSS leg.
                  </p>
                </div>
              </div>
            ) : null}

            <Field.Root>
              <Field.Label>Admin Emails</Field.Label>
              <Input
                placeholder="admin1@example.com, admin2@example.com"
                value={adminsText}
                onValueChange={(v) => setAdminsText(v)}
              />
              <Field.Description>Comma-separated. At least one required.</Field.Description>
            </Field.Root>

            <div>
              <h3>Pilot Statuses</h3>
              <p>
                Statuses pilots can be marked with per task (e.g. "safely landed", "DNF"). The
                "on track upload" knob decides whether uploading a track clears the status
                (useful for DNF) or leaves it alone (useful for "safely landed", which is
                implied by a track).
              </p>
              <ul>
                {statuses.map((s) => (
                  <li key={s.id}>
                    <Input
                      placeholder="e.g. Safely landed"
                      maxLength={128}
                      aria-label="Status label"
                      value={s.label}
                      onValueChange={(v) => updateStatus(s.id, { label: v })}
                    />{" "}
                    <SimpleSelect
                      value={s.on_track_upload}
                      onChange={(v) =>
                        updateStatus(s.id, {
                          on_track_upload: v as PilotStatusConfig["on_track_upload"],
                        })
                      }
                      options={[
                        { value: "none", label: "Keep" },
                        { value: "clear", label: "Clear" },
                        { value: "set", label: "Set" },
                      ]}
                      ariaLabel="On track upload"
                    />{" "}
                    <button
                      type="button"
                      onClick={() => setStatuses((prev) => prev.filter((x) => x.id !== s.id))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() =>
                  setStatuses((prev) => [
                    ...prev,
                    { id: nextStatusId.current++, key: "", label: "", on_track_upload: "none" },
                  ])
                }
              >
                + Add status
              </button>
            </div>

            <button type="button" onClick={() => void deleteComp()}>
              Delete competition
            </button>{" "}
            <Dialog.Close>Cancel</Dialog.Close>{" "}
            <button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
