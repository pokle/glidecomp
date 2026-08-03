/**
 * Create a test IGC — synthesise a tracklog that flies THIS task, and download
 * it.
 *
 * An organiser's tool, and deliberately not a hidden one: testing track
 * submission, scoring and the report card needs files, and the only other ways
 * to get one are to go flying or to reuse a bundled sample that was flown
 * somewhere else on some other day. A sample from the wrong day is withheld by
 * track quality, so it exercises the failure path while looking like the happy
 * one — which is worse than having no file at all.
 *
 * The synthesis is the engine's (`web/engine/src/forge-igc.ts`), shared with
 * the `bun run forge-igc` CLI so the two cannot drift into making different
 * files. What this adds is the verdict: every file is put through `parseIGC`
 * and `assessTrackQuality` — the same code the worker runs on upload — before
 * it is offered, so the panel says whether the file will be ACCEPTED and
 * SCORED rather than whether it looks about right.
 *
 * An open-distance task has no route and no goal, so the slider changes
 * meaning rather than disappearing: how far beyond the take-off cylinder the
 * pilot landed, in a direction the engine picks at random. The range comes
 * from `forgeRange` — asking the optimiser for a task line that does not exist
 * is what produced a zero-width slider and a NaN.
 *
 * Nothing here reaches the server. It makes a file and offers it as a
 * download, so opening this can't touch a competition — submitting the file
 * afterwards goes through the ordinary upload path, audit log and all.
 *
 * Loaded lazily. Only a comp's own admins can open it, so its code has no
 * business in the bundle every pilot downloads.
 */
import { useMemo, useState } from "react";
import {
  assessTrackQuality,
  forgeIgc,
  forgeRange,
  parseIGC,
  summariseFlight,
  startSecondsFor,
  zoneOffsetHours,
  type ForgeSabotage,
  type XCTask,
} from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { NumberField, TextField } from "@/react/rac/field";
import { SimpleSelect } from "@/react/rac/select";
import { Slider } from "@/react/rac/slider";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";

/** What the engine said about the file we just made. */
interface Verdict {
  text: string;
  fixCount: number;
  /**
   * The distance they should score: how far round the course they got, or on
   * an open-distance task how far beyond the take-off cylinder they landed.
   */
  courseMeters: number;
  flightDate: string | null;
  durationSeconds: number | null;
  trackKm: number;
  maxAltitude: number | null;
  shapeOk: boolean;
  hardFailed: boolean;
  findings: { id: string; severity: string; title: string }[];
}

const SABOTAGE: { value: ForgeSabotage; label: string }[] = [
  { value: "none", label: "Clean flight" },
  { value: "day", label: "Wrong day" },
  { value: "place", label: "Wrong place" },
];

export default function ForgeIgcDialog({
  open,
  onClose,
  taskName,
  taskDate,
  compName,
  timezone,
  category,
  xctsk,
}: {
  open: boolean;
  onClose: () => void;
  taskName: string;
  taskDate: string;
  compName: string;
  /** The competition's own zone — the one the wrong-day check judges in. */
  timezone: string | null;
  category: "hg" | "pg";
  xctsk: XCTask;
}) {
  const [pilot, setPilot] = useState("Test Pilot");
  const [glider, setGlider] = useState("Test Wing");
  const [startLocal, setStartLocal] = useState("13:00");
  const [rate, setRate] = useState(5);
  const [speedKmh, setSpeedKmh] = useState(32);
  const [sabotage, setSabotage] = useState<ForgeSabotage>("none");
  // How far this task can be asked to fly. On a GAP task that is the optimised
  // line — what the SCORER measures — so the slider's value is the distance the
  // pilot will be credited with, not merely one they travelled. An open-distance
  // task has no line and no goal, so the engine names the range instead: the
  // slider is then how far beyond the take-off cylinder they landed.
  const range = useMemo(() => forgeRange(xctsk), [xctsk]);
  const openDistance = range.openDistance;
  // Rounded to the slider's own step, so the top of the range is a value the
  // slider can actually hold. With a coarser step the maximum snapped DOWN and
  // the default became a land-out a few hundred metres short of goal — a
  // default that quietly does not do the ordinary thing.
  const taskKm = Math.round((range.maxMeters / 1000) * 10) / 10;
  const [stopAfterKm, setStopAfterKm] = useState(
    Math.min(taskKm, Math.round((range.defaultMeters / 1000) * 10) / 10)
  );
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zone = timezone ?? "UTC";
  const offset = zoneOffsetHours(taskDate, zone);

  function create() {
    setBusy(true);
    setProblem(null);
    setVerdict(null);
    try {
      const { text, fixCount, courseMeters } = forgeIgc(xctsk, {
        stopAfterMeters: stopAfterKm * 1000,
        pilot,
        glider,
        startSec: startSecondsFor(startLocal, taskDate, zone),
        rate,
        speedKmh,
        headerDate: new Date(`${taskDate}T00:00:00Z`),
        sabotage,
      });

      // The verdict, from the engine the worker runs. Anything less is a
      // guess about whether the file would be accepted.
      const igc = parseIGC(text);
      const summary = summariseFlight(igc);
      const quality = assessTrackQuality(igc.fixes, igc.header, {
        task: xctsk,
        taskDate,
        timeZone: timezone ?? undefined,
        category,
      });

      setVerdict({
        text,
        fixCount,
        courseMeters,
        flightDate: summary.flightDate,
        durationSeconds: summary.durationSeconds,
        trackKm: (summary.trackLengthMeters ?? 0) / 1000,
        maxAltitude: summary.maxAltitudeMeters,
        shapeOk: text[0] === "A" && text.includes("HFDTE"),
        hardFailed: quality.hardFailed,
        findings: quality.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
        })),
      });
    } catch (err) {
      // A task with one turnpoint, a waypoint with no coordinates: say what
      // happened rather than offering a file that was never made.
      setProblem(err instanceof Error ? err.message : "Could not create a flight.");
    } finally {
      setBusy(false);
    }
  }

  function download(v: Verdict) {
    downloadFile(
      `${slugify(compName)}-${slugify(taskName)}-${slugify(pilot)}.igc`,
      v.text,
      "application/octet-stream"
    );
  }

  // A clean flight that fails a HARD check is a bug in the generator, not a
  // finding — say so, because the file is then useless for the thing it was
  // asked for.
  const unexpectedlyWithheld =
    verdict != null && sabotage === "none" && verdict.hardFailed;

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog className="gap-3">
        <DialogHeader>
          <DialogTitle>Create a test IGC</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          For <strong>{taskName}</strong> on {taskDate} ({zone}, UTC
          {offset >= 0 ? "+" : ""}
          {offset}).
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Pilot name" value={pilot} onChange={setPilot} />
          <TextField label="Glider" value={glider} onChange={setGlider} />
          <TextField
            label="Take off (local)"
            value={startLocal}
            onChange={setStartLocal}
            validate={(v) =>
              /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : "Use HH:MM"
            }
          />
          <NumberField
            label="Fix interval (s)"
            value={rate}
            onChange={setRate}
            minValue={1}
            maxValue={60}
          />
          <NumberField
            label="Cruise (km/h)"
            value={speedKmh}
            onChange={setSpeedKmh}
            minValue={5}
            maxValue={120}
          />
          <SimpleSelect
            label="What kind of flight?"
            value={sabotage}
            onChange={(v) => setSabotage(v as ForgeSabotage)}
            options={SABOTAGE}
            className="w-full"
          />
        </div>

        {taskKm > 0 ? (
          <Slider
            label={openDistance ? "Flew" : "Landed out after"}
            value={stopAfterKm}
            onChange={setStopAfterKm}
            minValue={0}
            maxValue={taskKm}
            step={0.1}
            format={(v) =>
              openDistance
                ? v <= 0
                  ? "0.0 km — landed in the launch paddock"
                  : `${v.toFixed(1)} km beyond the launch cylinder`
                : v >= taskKm
                  ? `${v.toFixed(1)} km — made goal`
                  : `${v.toFixed(1)} km of ${taskKm.toFixed(1)} km`
            }
            description={
              openDistance
                ? "Open distance is measured from the take-off cylinder edge to the furthest fix, so this is what the pilot should be scored for. There is no route to follow, so the flight heads off in a random direction; at zero they never leave the cylinder and score nothing."
                : "Distance along the optimised task line, so this is what the pilot should be scored for. At the far right they make goal; at zero they land back at launch."
            }
          />
        ) : (
          // A GAP task whose route is a single point has no course to fly, and
          // a slider from zero to zero is not a control — it is a NaN.
          <p className="text-sm text-muted-foreground">
            This task&rsquo;s route has no distance to fly, so there is no
            flight to make. Set a route with at least two turnpoints.
          </p>
        )}

        {problem ? (
          <Alert variant="destructive">
            <AlertTitle>Nothing to fly</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}

        {verdict ? (
          <div className="flex flex-col gap-2">
            <Alert variant={unexpectedlyWithheld ? "destructive" : undefined}>
              <AlertTitle>
                {!verdict.shapeOk
                  ? "This file would be rejected on upload"
                  : unexpectedlyWithheld
                    ? "This was meant to be clean, but it fails a hard check"
                    : verdict.hardFailed
                      ? "Created — and withheld from scoring, as asked"
                      : "Created, and the engine accepts it"}
              </AlertTitle>
              <AlertDescription>
                <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <Fact label="Flight date" value={verdict.flightDate ?? "—"} />
                  <Fact
                    label={openDistance ? "Open distance" : "Course flown"}
                    value={`${(verdict.courseMeters / 1000).toFixed(1)} km`}
                  />
                  <Fact label="Airborne" value={hhmm(verdict.durationSeconds)} />
                  <Fact label="Track" value={`${verdict.trackKm.toFixed(1)} km`} />
                  <Fact
                    label="Highest"
                    value={verdict.maxAltitude == null ? "—" : `${Math.round(verdict.maxAltitude)} m`}
                  />
                  <Fact label="Fixes" value={verdict.fixCount.toLocaleString()} />
                  <Fact
                    label="Size"
                    value={`${(verdict.text.length / 1024).toFixed(0)} KB`}
                  />
                </dl>
                {verdict.findings.length > 0 ? (
                  <ul className="mt-2 list-inside list-disc text-sm">
                    {verdict.findings.map((f) => (
                      <li key={f.id}>
                        [{f.severity}] {f.title}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        <DialogFooter>
          <Button slot="close" variant="outline">
            Close
          </Button>
          <Button variant="outline" isPending={busy} pendingLabel="Creating" onPress={create}>
            {verdict ? "Create again" : "Create"}
          </Button>
          {verdict?.shapeOk ? (
            <Button onPress={() => download(verdict)}>Download .igc</Button>
          ) : null}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function hhmm(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  const total = Math.round(seconds / 60);
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}
