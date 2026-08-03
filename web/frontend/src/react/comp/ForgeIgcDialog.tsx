/**
 * IGC Forge — synthesise a tracklog that flies THIS task, and download it.
 *
 * A super-admin tool, and deliberately not a hidden one: testing track
 * submission, scoring and the report card needs files, and the only other ways
 * to get one are to go flying or to reuse a bundled sample that was flown
 * somewhere else on some other day. A sample from the wrong day is withheld by
 * track quality, so it exercises the failure path while looking like the happy
 * one — which is worse than having no file at all.
 *
 * The forging is the engine's (`web/engine/src/forge-igc.ts`), shared with the
 * `bun run forge-igc` CLI so the two cannot drift into making different files.
 * What this adds is the verdict: every forged file is put through `parseIGC`
 * and `assessTrackQuality` — the same code the worker runs on upload — before
 * it is offered, so the panel says whether the file will be ACCEPTED and
 * SCORED rather than whether it looks about right.
 *
 * Loaded lazily. Nobody but a super admin can open it, so its code has no
 * business in the bundle everyone else downloads.
 */
import { useState } from "react";
import {
  assessTrackQuality,
  forgeIgc,
  parseIGC,
  summariseFlight,
  turnpointsFromTask,
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
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";

/** What the engine said about the file we just made. */
interface Verdict {
  text: string;
  fixCount: number;
  flightDate: string | null;
  durationSeconds: number | null;
  trackKm: number;
  maxAltitude: number | null;
  shapeOk: boolean;
  hardFailed: boolean;
  findings: { id: string; severity: string; title: string }[];
}

const SABOTAGE: { value: ForgeSabotage; label: string }[] = [
  { value: "none", label: "A clean flight" },
  { value: "day", label: "Wrong day — withheld from scoring" },
  { value: "place", label: "Wrong place — withheld from scoring" },
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
  const [pilot, setPilot] = useState("Forged Pilot");
  const [glider, setGlider] = useState("Test Wing");
  const [startLocal, setStartLocal] = useState("13:00");
  const [rate, setRate] = useState(5);
  const [speedKmh, setSpeedKmh] = useState(32);
  const [sabotage, setSabotage] = useState<ForgeSabotage>("none");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const zone = timezone ?? "UTC";
  const offset = zoneOffsetHours(taskDate, zone);

  function forge() {
    setBusy(true);
    setProblem(null);
    setVerdict(null);
    try {
      const tps = turnpointsFromTask(xctsk);
      const { text, fixCount } = forgeIgc(tps, {
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
      setProblem(err instanceof Error ? err.message : "Could not forge a flight.");
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

  // A clean forge that fails a HARD check is a bug in the forge, not a
  // finding — say so, because the file is then useless for the thing it was
  // asked for.
  const unexpectedlyWithheld =
    verdict != null && sabotage === "none" && verdict.hardFailed;

  return (
    <Modal isOpen={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <Dialog className="gap-3">
        <DialogHeader>
          <DialogTitle>IGC Forge</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          Fly <strong>{taskName}</strong> on {taskDate} ({zone}, UTC
          {offset >= 0 ? "+" : ""}
          {offset}) and download the tracklog. Nothing is uploaded — submit it
          yourself to test the real path.
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
          <div className="flex flex-col gap-2">
            <SimpleSelect
              value={sabotage}
              onChange={(v) => setSabotage(v as ForgeSabotage)}
              options={SABOTAGE}
              ariaLabel="What kind of flight"
              className="w-full"
            />
          </div>
        </div>

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
                      ? "Forged — and withheld from scoring, as asked"
                      : "Forged, and the engine accepts it"}
              </AlertTitle>
              <AlertDescription>
                <dl className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                  <Fact label="Flight date" value={verdict.flightDate ?? "—"} />
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
          <Button variant="outline" isPending={busy} pendingLabel="Forging" onPress={forge}>
            {verdict ? "Forge again" : "Forge"}
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
