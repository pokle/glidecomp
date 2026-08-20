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
import { Button } from "@/react/rac/button";
import { Label } from "@/react/rac/field";
import { Input } from "@/react/rac/field";
import { SearchableChoiceList } from "@/react/rac/choice-list";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { compressIgc, fetchWithRetry, type PilotListEntry } from "./types";
import {
  IDENTIFIER_KINDS,
  NEW_PILOT_SENTINEL,
  NOT_AN_IGC_MESSAGE,
  inferIdentifierKind,
  pickDefaultTask,
  readLastSubmission,
  repairStepFor,
  taskLine,
  tooLargeReason,
  writeLastSubmission,
  type FlightSummaryWire,
  type IdentifierKind,
  type OpenComp,
  type OpenCompsResponse,
  type RegistrationState,
  type TrackQualityWire,
  type SubmitError,
  type SubmitStep,
} from "./submit-track";
import {
  RegistrationPicker,
  StepBox,
  SubmitFailure,
  TaskPicker,
  TrackAccepted,
} from "./SubmitTrackSteps";

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
  // Which registration in this comp the signed-in pilot is (or must pick).
  // Null while unknown — which is not the same as "new", and must never be
  // rendered as though it were.
  const [registration, setRegistration] = useState<RegistrationState | null>(null);
  // Their answer to the picker: a comp_pilot_id, or NEW_PILOT_SENTINEL.
  const [chosenRegistration, setChosenRegistration] = useState<string | null>(null);
  // An identifier they typed to find themselves another way ("I'm registered
  // under my CIVL id"), which re-runs the resolve.
  const [identifierOverride, setIdentifierOverride] = useState<{
    kind: IdentifierKind;
    value: string;
  } | null>(null);

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

  // Which registration in this comp is this signed-in pilot? Asked NOW, while
  // they are still choosing a file, because the upload route refuses to guess
  // when the roster holds registrations nobody has claimed — and a refusal
  // that arrives after the file has been chosen is a refusal at the worst
  // possible moment.
  useEffect(() => {
    if (!user || !compId) {
      setRegistration(null);
      return;
    }
    let cancelled = false;
    setRegistration(null);
    setChosenRegistration(null);
    (async () => {
      try {
        // Through fetchWithRetry: a dropped resolve must not be recorded as
        // "you are new", which is a terminal-looking answer nothing re-asks.
        const res = await fetchWithRetry(() =>
          fetch(`/api/comp/${encodeURIComponent(compId)}/registration/resolve`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(identifierOverride ? { identifier: identifierOverride } : {}),
          })
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as RegistrationState;
        if (!cancelled) setRegistration(data);
      } catch {
        // Leave it null. The upload still works for anyone the server can
        // resolve by itself, and answers 409 for anyone it cannot.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, user, identifierOverride]);

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
    // Asked and unanswered. A nicety only — the server refuses to guess either
    // way (409 identity_ambiguous) — but being stopped before the upload beats
    // being stopped after it.
    if (
      user &&
      onBehalfOf === SELF &&
      registration?.state === "choose" &&
      !chosenRegistration
    ) {
      return fail(
        "Tell us which registration is yours, so your track is not filed under a second entry.",
        "identity_ambiguous"
      );
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
        if (onBehalfOf !== SELF) {
          url = `${base}/${encodeURIComponent(onBehalfOf)}`;
        } else if (chosenRegistration) {
          // Which registration this is. Only ever sent when the pilot answered
          // the question — the server's own resolution is otherwise the one
          // that applies, and it refuses to guess rather than duplicating.
          headers["x-comp-pilot"] = chosenRegistration;
        }
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
          <div className="flex flex-col gap-4">
            {/* A collapsed list, not a popover (#638): a roster runs to
                dozens of pilots, and on a phone a floating list of them opens
                over the form and can be covered by the keyboard the search
                box summons. Collapsed it is one row either way. */}
            {canUploadOnBehalf ? (
              <SearchableChoiceList
                label="Submitting for"
                value={onBehalfOf}
                onChange={(v) => setOnBehalfOf(v || SELF)}
                options={[
                  { value: SELF, label: user.name ? `Myself (${user.name})` : "Myself" },
                  ...pilots.map((p) => ({
                    value: p.comp_pilot_id,
                    label: `${p.name} (${p.pilot_class})`,
                  })),
                ]}
                searchLabel="Search pilots"
                searchPlaceholder="Type a pilot's name"
              />
            ) : (
              // Nobody else to choose: a control with one option is a
              // sentence pretending to be a choice.
              <div className="flex flex-col gap-2">
                <Label>Submitting for</Label>
                <p className="text-sm text-muted-foreground">
                  {user.name ? `Myself (${user.name})` : "Myself"}
                </p>
              </div>
            )}
            {/* Only when submitting as themselves: the on-behalf picker above
                already names an exact registration. */}
            {onBehalfOf === SELF && compId ? (
              <RegistrationPicker
                registration={registration}
                chosen={chosenRegistration}
                onChoose={setChosenRegistration}
                onIdentifier={setIdentifierOverride}
                identifierOverride={identifierOverride}
                accountEmail={user.email ?? ""}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              No account needed. Tell us how you are registered for this
              competition and we will match you to the roster.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-2 sm:w-56">
                <SearchableChoiceList
                  label="Identify yourself by"
                  value={identifierKind}
                  onChange={(v) => {
                    identityTouched.current = true;
                    setIdentifierKind(v as IdentifierKind);
                  }}
                  options={IDENTIFIER_KINDS}
                  searchLabel="Identify yourself by"
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
        {/* Said BEFORE a file is chosen, not after the fact. Both halves are
            literally true of every submission: the audit log is the
            competition's public transparency record, and every upload emails
            the registered pilot (see track-notice-email.ts). */}
        <p className="mt-3 text-sm text-muted-foreground">
          This submission is recorded in the competition's public activity log,
          and we email the registered pilot to tell them about it.
        </p>
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
