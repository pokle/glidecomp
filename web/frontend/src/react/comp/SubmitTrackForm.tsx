/**
 * Submitting a track: the three things it takes, and what came of it.
 *
 * The `/submit` page (pages/SubmitTrack.tsx) is its only presentation. A pilot
 * who has just landed arrives from the homepage knowing nothing but their own
 * name and their file, so all three steps are asked. The comp page links to
 * `/submit?comp=`, and the task page to `/submit?comp=&task=`, where the task
 * is already known and that step collapses to a line. The task page used to
 * open this form in a dialog instead (SubmitTrackDialog, deleted in #820): a
 * dialog with text fields is the overlay the "no full-screen overlays" rule in
 * CLAUDE.md retired, and a page gets Back, reload and the keyboard for free.
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
 *
 * It is the kit form (`rac/form.tsx`, #820). A refusal that one step can fix
 * — a wrong identifier, a bad file, a task closed for the day — is shown
 * under that step's field, which is focused, and the step's border turns red.
 * A refusal no field can fix — a sign-in, a wait, a duplicated roster row, a
 * closed comp — is pinned beside Submit with its help: the sign-in, when to
 * try again, the organisers to write to. The form's own checks are read the
 * same way as the server's refusals, so they land by the same rule.
 * docs/track-submission.md, "Errors are repairable".
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Label, TextField } from "@/react/rac/field";
import { SearchableChoiceList } from "@/react/rac/choice-list";
import {
  Form,
  FormErrorBanner,
  SubmitButton,
  type Refusal,
  type SubmitResponse,
} from "@/react/rac/form";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { compressIgc, fetchWithRetry, type PilotListEntry } from "./types";
import {
  IDENTIFIER_KINDS,
  NOT_AN_IGC_MESSAGE,
  igcPilotNameFromText,
  inferIdentifierKind,
  pickDefaultTask,
  readLastSubmission,
  refusalField,
  submissionRequest,
  submitErrorFrom,
  taskLine,
  tooLargeReason,
  writeLastSubmission,
  type FlightSummaryWire,
  type IdentifierKind,
  type OpenComp,
  type SubmitAcceptedWire,
  type OpenCompsResponse,
  type RegistrationState,
  type TrackQualityWire,
  type SubmitError,
  SUBMIT_FIELD,
} from "./submit-track";
import {
  IgcFileField,
  RefusalHelp,
  RegistrationPicker,
  StepBox,
  TaskPicker,
  TrackAccepted,
} from "./SubmitTrackSteps";

const SELF = "self";

/**
 * A refusal the form makes itself, shaped as the server's are, so it lands by
 * the same rule: under the field that can fix it, or else beside Submit.
 */
function ownRefusal(error: string, code?: SubmitError["code"]): SubmitResponse {
  const body: SubmitError = { error, code };
  return {
    ok: false,
    status: 400,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

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

// Lives in submit-track.ts with the rest of the flow's rules; kept
// importable from here.
export { igcPilotNameFromText };

export function SubmitTrackForm({ prefill }: { prefill?: SubmitTrackPrefill }) {
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
  // already named the task — the task page's link, where the pilot has just
  // been looking at that task and a list of one is noise. Once open it stays
  // open; nothing the pilot does in the list closes it.
  const [editingTask, setEditingTask] = useState(!prefill?.taskId);

  // ── Who it is for
  const [identifierKind, setIdentifierKind] = useState<IdentifierKind>("email");
  const [identifierValue, setIdentifierValue] = useState("");
  const [onBehalfOf, setOnBehalfOf] = useState(SELF);
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
  const [result, setResult] = useState<SubmitTrackResult | null>(null);
  // What the last ok upload answered, read by the form's onSuccess.
  const accepted = useRef<SubmitTrackResult | null>(null);

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
    if (prefill?.compName && prefill?.taskName) return; // the caller named both
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

  // A signed-in pilot's own identity.
  useEffect(() => {
    if (!user) return;
    if (!identityTouched.current) {
      setIdentifierKind("email");
      setIdentifierValue(user.email ?? "");
    }
  }, [user]);

  // Whether this signed-in person may submit for OTHER pilots of the chosen
  // comp, and the roster they would choose from: its admins always, and a
  // pilot on the roster when the comp has `open_igc_upload` on. The form
  // works this out itself rather than being told, because the page is reached
  // by a link — a reload or a shared URL has nobody to tell it.
  const [onBehalf, setOnBehalf] = useState<{
    compId: string;
    isAdmin: boolean;
    openIgcUpload: boolean;
    pilots: PilotListEntry[];
  } | null>(null);
  useEffect(() => {
    setOnBehalfOf(SELF);
    if (!user || !compId) {
      setOnBehalf(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const compRes = await api.api.comp[":comp_id"].$get({
          param: { comp_id: compId },
        });
        if (!compRes.ok || cancelled) return;
        const comp = (await compRes.json()) as {
          is_admin?: boolean;
          open_igc_upload?: boolean;
        };
        const isAdmin = !!comp.is_admin;
        const openIgcUpload = !!comp.open_igc_upload;
        let pilots: PilotListEntry[] = [];
        if (isAdmin || openIgcUpload) {
          const res = await api.api.comp[":comp_id"].pilot.$get({
            param: { comp_id: compId },
          });
          if (cancelled) return;
          if (res.ok) pilots = ((await res.json()) as { pilots: PilotListEntry[] }).pilots;
        }
        if (!cancelled) setOnBehalf({ compId, isAdmin, openIgcUpload, pilots });
      } catch {
        // Non-fatal: the user can still submit for themselves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, user]);
  const actsAsAdmin = useAdminView(!!onBehalf?.isAdmin);
  const canUploadOnBehalf =
    !!user &&
    onBehalf?.compId === compId &&
    (actsAsAdmin ||
      (onBehalf.openIgcUpload && onBehalf.pilots.some((p) => p.linked_email === user.email)));
  const pilots = canUploadOnBehalf ? onBehalf.pilots : [];

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

  /**
   * Send it. The form's own checks first, each answered as a refusal (see
   * ownRefusal); then the upload, whose response the kit form reads.
   */
  async function upload(): Promise<SubmitResponse> {
    if (!compId || !taskId) return ownRefusal("Choose the task you flew.", "task_not_found");
    if (!file) return ownRefusal("Choose your IGC file.", "invalid_file");
    if (!file.name.toLowerCase().endsWith(".igc")) {
      return ownRefusal(NOT_AN_IGC_MESSAGE, "invalid_file");
    }
    if (!user && identifierValue.trim() === "") {
      return ownRefusal("Tell us who the track is for.", "bad_identifier");
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
      return ownRefusal(
        "Tell us which registration is yours, so your track is not filed under a second entry.",
        "identity_ambiguous"
      );
    }

    // A throw from here on is a request that never got an answer, which the
    // kit form reports in its own words, keeping everything chosen.
    const compressed = await compressIgc(file);
    const tooLarge = tooLargeReason(file.size, compressed.byteLength);
    if (tooLarge) return ownRefusal(tooLarge, "invalid_file");

    // Which endpoint is decided by the shared rules, so the website and
    // the app can never disagree about it. Signed in: the existing routes,
    // and with them open registration and whatever on-behalf rights this
    // pilot already has. The registration answer is only ever sent when the
    // pilot gave one — the server's own resolution otherwise applies, and
    // it refuses to guess rather than duplicating.
    const { path: url, headers } = submissionRequest(
      compId,
      taskId,
      user
        ? onBehalfOf !== SELF
          ? { kind: "on-behalf", compPilotId: onBehalfOf }
          : { kind: "self", registration: chosenRegistration }
        : { kind: "anonymous", identifierKind, identifierValue }
    );

    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: compressed,
    });
    if (!res.ok) return res;

    const data = (await res.json()) as SubmitAcceptedWire;
    accepted.current = {
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
    return res;
  }

  /**
   * Where a refusal is shown: under the field of the step that can fix it, or
   * else beside Submit with its help. The sentence is the server's, word for
   * word; a body with none still says something.
   */
  function shapeRefusal(_refusal: Refusal, body: unknown): Refusal {
    const failure = submitErrorFrom(body);
    const field = refusalField(failure, !!user);
    // A collapsed task step has no field to show it under. Open it first, so
    // the list is there when the form looks for the field.
    if (field === SUBMIT_FIELD.task) flushSync(() => setEditingTask(true));
    return {
      message: failure.error,
      field: field ?? undefined,
      help: <RefusalHelp failure={failure} />,
    };
  }

  // ── The result replaces the form, and stays until the pilot leaves. Its
  // first action goes to what was made — the pilot's provisional score card.
  if (result) {
    return (
      <TrackAccepted
        result={result}
        onAnother={() => {
          setResult(null);
          setFile(null);
          setIgcPilotName(null);
        }}
      />
    );
  }

  return (
    <Form
      className="flex flex-col gap-6"
      onSubmit={upload}
      shapeRefusal={shapeRefusal}
      onSuccess={() => setResult(accepted.current)}
    >
      <StepBox
        n={1}
        title="Which task did you fly?"
        answered={
          !editingTask && !!taskId
            ? taskLine(selectedComp, selectedTask, prefill, linkedNames)
            : null
        }
        onChange={prefilledComp && !openComps ? undefined : () => setEditingTask(true)}
        fields={[SUBMIT_FIELD.task]}
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
        fields={[SUBMIT_FIELD.identifier, SUBMIT_FIELD.registration]}
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
              No account needed — we&rsquo;ll find you on the roster.
            </p>
            {/* Tops aligned, not bottoms: an error under the identifier
                would otherwise lift it above the kind beside it. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
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
              <TextField
                className="flex-1"
                label={IDENTIFIER_KINDS.find((k) => k.value === identifierKind)?.label}
                name={SUBMIT_FIELD.identifier}
                value={identifierValue}
                autoComplete={identifierKind === "email" ? "email" : "off"}
                inputMode={identifierKind === "email" ? "email" : "text"}
                onChange={(next) => {
                  identityTouched.current = true;
                  setIdentifierValue(next);
                  setIdentifierKind((k) => inferIdentifierKind(next, k));
                }}
              />
            </div>
          </div>
        )}
        {/* Said BEFORE a file is chosen, not after the fact. Both halves are
            literally true of every submission: the audit log is the
            competition's public transparency record, and every upload emails
            the registered pilot (see track-notice-email.ts). */}
        <p className="mt-3 text-sm text-muted-foreground">
          Submissions are logged publicly and emailed to the registered pilot.
        </p>
      </StepBox>

      <StepBox n={3} title="Your IGC file" fields={[SUBMIT_FIELD.file]}>
        <IgcFileField file={file} onPick={(files) => void onFilePicked(files)} />
        {igcPilotName ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Pilot named in the file: <strong>{igcPilotName}</strong>
          </p>
        ) : null}
      </StepBox>

      {/* Beside Submit, where it cannot scroll away from the button. */}
      <FormErrorBanner title="We could not accept that track" />

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton pendingLabel="Submitting">Submit track</SubmitButton>
      </div>
    </Form>
  );
}
