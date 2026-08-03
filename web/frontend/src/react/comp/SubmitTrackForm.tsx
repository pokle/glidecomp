/**
 * Submitting a track: the three things it takes, and what came of it.
 *
 * One component, two presentations. On `/submit` it is the page — a pilot who
 * has just landed arrives from the homepage knowing nothing but their own
 * name and their file, so all three steps are asked. Opened from a task page
 * it is wrapped in the compact dialog (SubmitTrackDialog), where comp and task
 * are already known and those steps collapse to a line. (The comp page has no
 * task to name yet, so it links to /submit?comp= instead of opening the
 * dialog.)
 *
 * A step that arrives prefilled shows its answer with a Change button rather
 * than disappearing: the commonest failure of a flow like this is filing a
 * track against yesterday's task without ever being shown which task it was.
 *
 * Which endpoint gets used is decided in one place, by whether there is a
 * session — signed-in pilots keep the existing authenticated routes (and with
 * them open registration and the on-behalf picker), and everyone else goes to
 * the anonymous route, which matches the typed identifier against the comp's
 * roster.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { Button, LinkButton } from "@/react/rac/button";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Label } from "@/react/rac/field";
import { Input } from "@/react/rac/field";
import { Loading } from "@/react/rac/progress";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { SimpleSelect } from "@/react/rac/select";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { pilotPath } from "../lib/slug";
import { compressIgc, fetchWithRetry, type PilotListEntry } from "./types";
import {
  IDENTIFIER_KINDS,
  NOT_AN_IGC_MESSAGE,
  formatClockInZone,
  formatDuration,
  formatKm,
  formatMetres,
  formatRetryAfter,
  inferIdentifierKind,
  needsSignIn,
  pickDefaultTask,
  readLastSubmission,
  repairStepFor,
  taskLine,
  tooLargeReason,
  unnamedClasses,
  writeLastSubmission,
  type FlightSummaryWire,
  type IdentifierKind,
  type OpenComp,
  type OpenCompsResponse,
  type TrackQualityWire,
  type SubmitError,
  type SubmitStep,
} from "./submit-track";

const SELF = "self";

/** What the caller already knows. Anything absent becomes a step to ask. */
export interface SubmitTrackPrefill {
  compId?: string;
  compName?: string;
  taskId?: string;
  taskName?: string;
}

export interface SubmitTrackResult {
  compId: string;
  taskId: string;
  compPilotId: string;
  compName: string | null;
  taskName: string | null;
  pilotName: string | null;
  replaced: boolean;
  flightSummary: FlightSummaryWire | null;
  trackQuality: TrackQualityWire;
  notified?: { emailed: boolean; reason?: string; masked_to?: string };
  timezone: string | null;
}

/**
 * Pull the pilot's name out of an IGC header (HFPLTPILOTINCHARGE / HOPLT…).
 * Returns null for missing or placeholder values ("not set", "unknown").
 */
export function igcPilotNameFromText(text: string): string | null {
  const m = text.match(/^H[FOP]PLT[^:\r\n]*:[ \t]*(.+?)[ \t]*\r?$/im);
  const name = m?.[1]?.trim();
  if (!name || /^(not[ _-]?set|unknown|pilot)$/i.test(name)) return null;
  return name;
}

export function SubmitTrackForm({
  prefill,
  canUploadOnBehalf = false,
  onUploaded,
  onDone,
  compact = false,
}: {
  prefill?: SubmitTrackPrefill;
  /** Signed-in on-behalf rights, unchanged from today. */
  canUploadOnBehalf?: boolean;
  /** Fired on every successful upload, so a host page can refresh. */
  onUploaded?: (result: SubmitTrackResult) => void;
  /** The dialog's "close"; absent on the page, which has nothing to close. */
  onDone?: () => void;
  /** Compact chrome for the dialog presentation. */
  compact?: boolean;
}) {
  const { user } = useUser();

  // ── What we are submitting to
  const [openComps, setOpenComps] = useState<OpenComp[] | null>(null);
  // Names looked up for a task the caller gave by id alone (a QR code, a
  // poster). Null until asked, and stays null when the caller supplied names.
  const [linkedNames, setLinkedNames] = useState<{
    compName: string | null;
    taskName: string | null;
    pilotClasses?: string[];
  } | null>(null);
  const [compId, setCompId] = useState(prefill?.compId ?? "");
  const [taskId, setTaskId] = useState(prefill?.taskId ?? "");
  // Whether the task list is on screen. It starts closed ONLY when the caller
  // already named the task — the dialog on a comp or task page, where the flow
  // is a two-field form and a list of one is noise. Once open it stays open;
  // nothing the pilot does in the list closes it.
  const [editingTask, setEditingTask] = useState(!prefill?.taskId);

  // ── Who it is for
  const [identifierKind, setIdentifierKind] = useState<IdentifierKind>("email");
  const [identifierValue, setIdentifierValue] = useState("");
  const [onBehalfOf, setOnBehalfOf] = useState(SELF);
  const [pilots, setPilots] = useState<PilotListEntry[]>([]);

  // ── The file
  const [file, setFile] = useState<File | null>(null);
  const [igcPilotName, setIgcPilotName] = useState<string | null>(null);

  // ── Outcome
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<SubmitError | null>(null);
  const [result, setResult] = useState<SubmitTrackResult | null>(null);

  const identityTouched = useRef(false);

  const prefilledComp = prefill?.compId != null;

  // The open competitions — what the task picker lists.
  //
  // Fetched even when the caller already named a task. It used to return early
  // in that case, which broke the picker for exactly the callers that have a
  // prefill: pressing Change opened a list whose data had never been asked
  // for, so it sat on "Finding competitions flying now…" for good. The
  // response is public and edge-cached for 60s, so asking anyway is cheap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Through fetchWithRetry, not a bare fetch: a dropped request here
        // would otherwise read as "no competitions are open", which is a
        // terminal-looking answer nothing re-fetches.
        const res = await fetchWithRetry(() => fetch("/api/comp/open-now"));
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as OpenCompsResponse;
        if (cancelled) return;
        setOpenComps(data.comps);
        // A caller who named a task has already answered this. Re-deciding
        // would let the list overrule the URL somebody scanned off a poster.
        if (prefill?.taskId) return;
        const pick = pickDefaultTask(data.comps, {
          fromUrl: { compId: prefill?.compId, taskId: prefill?.taskId },
          last: readLastSubmission(
            typeof window === "undefined" ? undefined : window.localStorage
          ),
        });
        if (pick) {
          setCompId(pick.compId);
          setTaskId(pick.taskId);
        }
      } catch {
        // Non-fatal: the pilot can still reach a task page and submit there.
        if (!cancelled) setOpenComps([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefill?.compId, prefill?.taskId]);

  // Names for a task named by ID alone.
  //
  // `/submit?comp=…&task=…` is the QR-code-on-the-hill case, and it arrives
  // with two sqids and nothing readable. Without this the collapsed step said
  // "Selected task" — which is precisely the failure the step exists to
  // prevent: filing a track against yesterday's task without ever being shown
  // which task it was.
  //
  // Asked directly rather than read out of the open-comps list, because a
  // linked task need not be in it: the list is a ±2-day window over comps
  // still accepting uploads, and a poster outlives both.
  useEffect(() => {
    const wantComp = prefill?.compId;
    const wantTask = prefill?.taskId;
    if (!wantComp || !wantTask) return;
    if (prefill?.compName && prefill?.taskName) return; // the dialog knows both
    let cancelled = false;
    (async () => {
      try {
        const [compRes, taskRes] = await Promise.all([
          api.api.comp[":comp_id"].$get({ param: { comp_id: wantComp } }),
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: wantComp, task_id: wantTask },
          }),
        ]);
        if (cancelled) return;
        const compName = compRes.ok
          ? ((await compRes.json()) as { name?: string }).name ?? null
          : null;
        const task = taskRes.ok
          ? ((await taskRes.json()) as {
              name?: string;
              pilot_classes?: string[];
            })
          : null;
        if (cancelled) return;
        setLinkedNames({
          compName,
          taskName: task?.name ?? null,
          pilotClasses: task?.pilot_classes,
        });
      } catch {
        // Non-fatal: the step falls back to saying nothing rather than
        // blocking an upload that would otherwise work.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefill?.compId, prefill?.taskId, prefill?.compName, prefill?.taskName]);

  // A signed-in pilot's own identity, and the on-behalf roster when they have
  // the right to use it. Both unchanged from the dialog's existing behaviour.
  useEffect(() => {
    if (!user) return;
    if (!identityTouched.current) {
      setIdentifierKind("email");
      setIdentifierValue(user.email ?? "");
    }
  }, [user]);

  useEffect(() => {
    if (!canUploadOnBehalf || !compId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].pilot.$get({
          param: { comp_id: compId },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { pilots: PilotListEntry[] };
        if (!cancelled) setPilots(data.pilots);
      } catch {
        // Non-fatal: the user can still submit for themselves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, canUploadOnBehalf]);

  // Remember the last identifier so day two of a comp costs no typing. Only
  // ever a convenience — the worker re-checks it against the roster.
  useEffect(() => {
    if (user || identityTouched.current) return;
    const last = readLastSubmission(
      typeof window === "undefined" ? undefined : window.localStorage
    );
    if (last) {
      setIdentifierKind(last.identifierKind);
      setIdentifierValue(last.identifierValue);
    }
  }, [user]);

  const selectedComp = useMemo(
    () => openComps?.find((c) => c.comp_id === compId) ?? null,
    [openComps, compId]
  );
  const selectedTask = useMemo(
    () => selectedComp?.tasks.find((t) => t.task_id === taskId) ?? null,
    [selectedComp, taskId]
  );

  async function onFilePicked(files: FileList | null) {
    setFailure(null);
    const picked = files?.[0] ?? null;
    setFile(picked);
    if (!picked) {
      setIgcPilotName(null);
      return;
    }
    try {
      setIgcPilotName(igcPilotNameFromText(await picked.text()));
    } catch {
      // Unreadable file — the upload step will report it properly.
      setIgcPilotName(null);
    }
  }

  function fail(message: string, code?: SubmitError["code"]) {
    setFailure({ error: message, code });
  }

  async function upload() {
    if (!compId || !taskId) return fail("Choose the task you flew.", "task_not_found");
    if (!file) return fail("Choose your IGC file.", "invalid_file");
    if (!file.name.toLowerCase().endsWith(".igc")) {
      return fail(NOT_AN_IGC_MESSAGE, "invalid_file");
    }
    if (!user && identifierValue.trim() === "") {
      return fail("Tell us who the track is for.", "bad_identifier");
    }

    setUploading(true);
    setFailure(null);
    try {
      const compressed = await compressIgc(file);
      const tooLarge = tooLargeReason(file.size, compressed.byteLength);
      if (tooLarge) return fail(tooLarge, "invalid_file");

      const base = `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc`;
      let url = base;
      const headers: Record<string, string> = {};
      if (user) {
        // Signed in: the existing routes, and with them open registration and
        // whatever on-behalf rights this pilot already has.
        if (onBehalfOf !== SELF) url = `${base}/${encodeURIComponent(onBehalfOf)}`;
      } else {
        url = `${base}/open-submit`;
        headers["x-pilot-ident-kind"] = identifierKind;
        headers["x-pilot-ident"] = encodeURIComponent(identifierValue.trim());
      }

      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: compressed,
      });

      if (!res.ok) {
        // Guarded: a non-JSON error body must not be reported as a network
        // error, which is what hid the real message before.
        const body = (await res.json().catch(() => ({}))) as Partial<SubmitError>;
        setFailure({
          ...body,
          error: body.error || "We could not accept that track.",
        });
        return;
      }

      const data = (await res.json()) as Record<string, any>;
      const uploaded: SubmitTrackResult = {
        compId,
        taskId,
        compPilotId: data.comp_pilot_id,
        compName: selectedComp?.name ?? prefill?.compName ?? null,
        taskName: selectedTask?.name ?? prefill?.taskName ?? null,
        pilotName: data.pilot_name ?? user?.name ?? null,
        replaced: !!data.replaced,
        flightSummary: data.flight_summary ?? null,
        trackQuality: data.track_quality ?? { hard_failed: false, findings: [] },
        notified: data.notified,
        timezone: selectedComp?.timezone ?? null,
      };

      if (!user) {
        writeLastSubmission(
          typeof window === "undefined" ? undefined : window.localStorage,
          {
            compId,
            taskId,
            identifierKind,
            identifierValue: identifierValue.trim(),
          }
        );
      }

      setResult(uploaded);
      onUploaded?.(uploaded);
    } catch {
      fail("We could not reach GlideComp. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  }

  // ── The result replaces the form. On the page it stays until the pilot
  // leaves; the dialog decides for itself whether to close (see the wrapper).
  if (result) {
    return (
      <TrackAccepted
        result={result}
        onAnother={() => {
          setResult(null);
          setFile(null);
          setIgcPilotName(null);
        }}
        onDone={onDone}
      />
    );
  }

  const repairStep = repairStepFor(failure?.code);

  return (
    <div className="flex flex-col gap-6">
      <StepBox
        n={1}
        title="Which task did you fly?"
        compact={compact}
        answered={
          !editingTask && !!taskId
            ? taskLine(selectedComp, selectedTask, prefill, linkedNames)
            : null
        }
        onChange={prefilledComp && !openComps ? undefined : () => setEditingTask(true)}
        highlight={repairStep === "task"}
      >
        <TaskPicker
          comps={openComps}
          compId={compId}
          taskId={taskId}
          onPick={(nextComp, nextTask) => {
            setCompId(nextComp);
            setTaskId(nextTask);
            // Deliberately does NOT collapse the step. Picking a task is not
            // finishing with it: a pilot who has just chosen wants to see the
            // dates either side to confirm, and changing their mind should not
            // cost a Change button. The list stays until they leave the page.
          }}
        />
      </StepBox>

      <StepBox
        n={2}
        title="Who is the track for?"
        compact={compact}
        highlight={repairStep === "identity"}
      >
        {user ? (
          <div className="flex flex-col gap-2">
            <Label>Submitting for</Label>
            <SimpleSelect
              value={onBehalfOf}
              onChange={(v) => setOnBehalfOf(v || SELF)}
              options={[
                { value: SELF, label: user.name ? `Myself (${user.name})` : "Myself" },
                ...pilots.map((p) => ({
                  value: p.comp_pilot_id,
                  label: `${p.name} (${p.pilot_class})`,
                })),
              ]}
              disabled={!canUploadOnBehalf}
              ariaLabel="Submitting for"
              className="w-full"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              No account needed. Tell us how you are registered for this
              competition and we will match you to the roster.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-2 sm:w-56">
                <Label id="ident-kind-label">Identify yourself by</Label>
                <SimpleSelect
                  value={identifierKind}
                  onChange={(v) => {
                    identityTouched.current = true;
                    setIdentifierKind(v as IdentifierKind);
                  }}
                  options={IDENTIFIER_KINDS}
                  ariaLabel="Identify yourself by"
                  className="w-full"
                />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="ident-value">
                  {IDENTIFIER_KINDS.find((k) => k.value === identifierKind)?.label}
                </Label>
                <Input
                  id="ident-value"
                  value={identifierValue}
                  autoComplete={identifierKind === "email" ? "email" : "off"}
                  inputMode={identifierKind === "email" ? "email" : "text"}
                  onChange={(e) => {
                    identityTouched.current = true;
                    const next = e.target.value;
                    setIdentifierValue(next);
                    setIdentifierKind((k) => inferIdentifierKind(next, k));
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </StepBox>

      <StepBox
        n={3}
        title="Your IGC file"
        compact={compact}
        highlight={repairStep === "file"}
      >
        <div className="flex flex-wrap items-center gap-2">
          <FileTrigger
            acceptedFileTypes={[".igc"]}
            onSelect={(files) => void onFilePicked(files)}
          >
            <Button variant="outline" size="sm">
              {file ? "Change file…" : "Choose IGC file…"}
            </Button>
          </FileTrigger>
          {file ? (
            <span className="truncate text-sm text-muted-foreground">{file.name}</span>
          ) : null}
        </div>
        {igcPilotName ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Pilot named in the file: <strong>{igcPilotName}</strong>
          </p>
        ) : null}
      </StepBox>

      {failure ? <SubmitFailure failure={failure} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          isPending={uploading}
          pendingLabel="Submitting"
          onPress={() => void upload()}
        >
          Submit track
        </Button>
        {onDone ? (
          <Button variant="outline" onPress={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One step of the flow.
 *
 * A step whose answer is already known shows the answer and a Change button
 * rather than vanishing — the pilot has to be able to see what they are about
 * to file the track against.
 */
function StepBox({
  n,
  title,
  children,
  answered,
  onChange,
  highlight,
  compact,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  answered?: string | null;
  onChange?: () => void;
  highlight?: boolean;
  compact?: boolean;
}) {
  return (
    <section
      className={
        highlight
          ? "rounded-lg border border-destructive/40 bg-destructive/5 p-4"
          : compact
            ? ""
            : "rounded-lg border p-4"
      }
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">
          {compact ? null : (
            <span className="mr-2 text-muted-foreground">{n}.</span>
          )}
          {title}
        </h2>
        {answered && onChange ? (
          <Button variant="outline" size="sm" onPress={onChange}>
            Change
          </Button>
        ) : null}
      </div>
      {answered ? (
        <p className="text-sm">{answered}</p>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}

/**
 * The comp/task chooser.
 *
 * A RadioGroup, not a row of buttons: this is one choice out of a small set
 * that must stay VISIBLE — seeing the date beside each task is how a pilot
 * avoids filing today's flight against yesterday's task, so a Select that
 * collapses to the chosen value would take away the thing worth reading.
 * Radio semantics also get the pilot arrow-key navigation and a screen reader
 * announcing "3 of 7" for free, neither of which a button row has.
 *
 * Tasks are grouped under their competition, and the value carries both ids
 * because a task id alone does not say which comp it belongs to.
 */
function TaskPicker({
  comps,
  compId,
  taskId,
  onPick,
}: {
  comps: OpenComp[] | null;
  compId: string;
  taskId: string;
  onPick: (compId: string, taskId: string) => void;
}) {
  const [query, setQuery] = useState("");

  if (comps === null) return <Loading>Finding competitions flying now…</Loading>;

  if (comps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No competitions are open for submissions right now. Open your
        competition's task page and submit from there.
      </p>
    );
  }

  const term = query.trim().toLowerCase();
  const matching =
    term.length < 2
      ? comps.slice(0, 3)
      : comps.filter((c) => c.name.toLowerCase().includes(term));

  // The chosen comp is always on screen, even when a later search or the
  // three-comp cap would have hidden it. A checked radio that is not rendered
  // is a selection the pilot cannot see, check or undo — which is the failure
  // this whole change is about.
  const chosen = compId ? comps.find((c) => c.comp_id === compId) : undefined;
  const filtered =
    chosen && !matching.includes(chosen) ? [chosen, ...matching] : matching;

  return (
    <div className="flex flex-col gap-3">
      {comps.length > 3 ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="comp-search">Find your competition</Label>
          <Input
            id="comp-search"
            value={query}
            placeholder="Competition name"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      <RadioGroup
        aria-label="Which task did you fly?"
        value={compId && taskId ? `${compId}:${taskId}` : null}
        onChange={(v) => {
          const [nextComp, nextTask] = v.split(":");
          onPick(nextComp, nextTask);
        }}
        className="gap-4"
      >
        {filtered.map((comp) => (
          <div key={comp.comp_id} className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">{comp.name}</p>
            {comp.tasks.map((task) => {
              const extra = unnamedClasses(task.name, task.pilot_classes);
              return (
                <Radio
                  key={task.task_id}
                  value={`${comp.comp_id}:${task.task_id}`}
                  // The visible parts are laid out with a flex gap, which is
                  // spacing and not text — without this the name is read
                  // "Today komoopen2026-08-02". Same words, same order, so the
                  // visible label is still contained in the accessible one.
                  aria-label={[task.name, extra, task.task_date]
                    .filter(Boolean)
                    .join(", ")}
                  className="w-full items-baseline gap-2.5 rounded-md px-1 py-1"
                >
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span>{task.name}</span>
                    {extra ? (
                      <span className="text-xs text-muted-foreground">{extra}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {task.task_date}
                    </span>
                  </span>
                </Radio>
              );
            })}
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}

/**
 * A failure the pilot can act on.
 *
 * Every message names what went wrong AND who or what can fix it. Where the
 * pilot cannot fix it themselves — a duplicated roster row, a comp that has
 * closed — it names the organiser and links a real mailto, exactly as the
 * public comp page does.
 */
function SubmitFailure({ failure }: { failure: SubmitError }) {
  const organisers = failure.organisers ?? [];
  return (
    <Alert variant="destructive">
      <AlertTitle>We could not accept that track</AlertTitle>
      <AlertDescription>
        <p>{failure.error}</p>
        {needsSignIn(failure.code) ? (
          <p className="mt-2">
            <LinkButton
              size="sm"
              href={`/signin?next=${encodeURIComponent(
                typeof window === "undefined" ? "/submit" : window.location.pathname
              )}`}
            >
              Sign in to submit
            </LinkButton>
          </p>
        ) : null}
        {failure.retry_after_seconds ? (
          <p className="mt-2">
            Try again {formatRetryAfter(failure.retry_after_seconds)}.
          </p>
        ) : null}
        {organisers.length > 0 ? (
          <p className="mt-2">
            {organisers.length === 1 ? "Organiser: " : "Organisers: "}
            {organisers.map((o, i) => (
              <span key={o.email}>
                {i > 0 ? ", " : ""}
                {o.name} (
                <a className="underline underline-offset-4" href={`mailto:${o.email}`}>
                  {o.email}
                </a>
                )
              </span>
            ))}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/**
 * What we received.
 *
 * The scores are a background revalidation away and depend on everyone else's
 * tracks, so this is the moment — and the only cheap one — at which a pilot
 * can notice they sent yesterday's file. Hence the times and the distance
 * rather than a bare tick.
 */
function TrackAccepted({
  result,
  onAnother,
  onDone,
}: {
  result: SubmitTrackResult;
  onAnother: () => void;
  onDone?: () => void;
}) {
  const s = result.flightSummary;
  const findings = result.trackQuality.findings;
  const zone = result.timezone;

  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>
          {result.replaced ? "Track replaced" : "Track submitted"}
          {result.pilotName ? ` for ${result.pilotName}` : ""}
        </AlertTitle>
        <AlertDescription>
          <p>
            {result.taskName ? `${result.taskName}, ` : ""}
            {result.compName ?? "your competition"}. Check the flight below is
            the one you meant to send.
          </p>
        </AlertDescription>
      </Alert>

      {s ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Fact label="Date" value={s.flight_date ?? "Not stated in the file"} />
          <Fact label="Take off" value={formatClockInZone(s.takeoff_at, zone)} />
          <Fact label="Landing" value={formatClockInZone(s.landing_at, zone)} />
          <Fact label="Airborne" value={formatDuration(s.duration_seconds)} />
          <Fact label="Track length" value={formatKm(s.track_length_m)} />
          <Fact label="Highest point" value={formatMetres(s.max_altitude_m)} />
          {s.header_glider_type ? (
            <Fact label="Glider" value={s.header_glider_type} />
          ) : null}
          {s.header_pilot_name ? (
            <Fact label="Named in the file" value={s.header_pilot_name} />
          ) : null}
        </dl>
      ) : null}

      {findings.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>
            {result.trackQuality.hard_failed
              ? "This track will not be scored as it stands"
              : "This track needs checking"}
          </AlertTitle>
          <AlertDescription>
            {findings.map((f) => (
              <p key={f.id}>{f.detail}</p>
            ))}
            <p className="mt-2">
              It is saved either way. Submit the right file and it replaces this
              one.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {result.notified?.emailed ? (
        <p className="text-sm text-muted-foreground">
          We emailed {result.notified.masked_to} to say their track was
          replaced.
        </p>
      ) : null}
      {result.notified && !result.notified.emailed ? (
        <p className="text-sm text-muted-foreground">
          We could not email a confirmation — no address is registered for this
          pilot. Tell the organiser if this was not you.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <LinkButton
          href={pilotPath(
            result.compId,
            result.compName,
            result.taskId,
            result.taskName,
            result.compPilotId,
            result.pilotName
          )}
          onPress={onDone}
        >
          View provisional score card
        </LinkButton>
        {/* No "Go to the task" here. The report card is the answer to "what
            did my track do", and the task page is one click on from it — a
            second, equal-looking button next to it only asks the pilot to
            choose between two things they cannot tell apart. */}
        <Button variant="outline" onPress={onAnother}>
          Submit another track
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Scores are provisional — they move as other pilots submit.
      </p>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
