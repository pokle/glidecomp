/**
 * The pieces the submit-track flow is assembled from: one step of the form,
 * the registration and task pickers, and the two outcomes — a failure with a
 * way back, and the receipt for an accepted track.
 *
 * Split out of SubmitTrackForm, which carried all of them below the component
 * that uses them and ran to 1,180 lines. The flow's decisions still live in
 * submit-track.ts, DOM-free and directly tested; this is only the rendering.
 */
import { useState } from "react";
import { Button, LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Input, Label } from "@/react/rac/field";
import { Loading } from "@/react/rac/progress";
import { Radio, RadioGroup } from "@/react/rac/radio-group";
import { SimpleSelect } from "@/react/rac/select";
import { useUnits } from "../lib/units";
import { pilotPath } from "../lib/slug";
import type { PilotListEntry } from "./types";
import {
  IDENTIFIER_KINDS,
  NEW_PILOT_SENTINEL,
  formatClockInZone,
  formatDuration,
  formatRetryAfter,
  formatTrackAltitude,
  formatTrackDistance,
  needsSignIn,
  unnamedClasses,
  type IdentifierKind,
  type OpenComp,
  type RegistrationState,
  type SubmitError,
} from "./submit-track";
import type { SubmitTrackResult } from "./SubmitTrackForm";


/**
 * One step of the flow.
 *
 * A step whose answer is already known shows the answer and a Change button
 * rather than vanishing — the pilot has to be able to see what they are about
 * to file the track against.
 */
export function StepBox({
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
  // `compact` is the dialog flow, where the dialog is already the panel — the
  // steps must NOT be cards there or it is panels inside a panel. Everywhere
  // else a step is a real card: these were bordered boxes with no background,
  // so on the tinted ground they read as three holes rather than three steps.
  //
  // A highlighted step keeps the card background and states itself with the
  // border. A translucent `bg-destructive/5` would have replaced `bg-card`
  // rather than sitting on it, tinting the page through instead of the panel.
  const Box = compact ? "section" : Card;
  return (
    <Box
      className={
        compact
          ? "flex flex-col gap-4"
          : highlight
            ? "border-destructive/40"
            : undefined
      }
    >
      <div className="flex items-center justify-between gap-3">
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
    </Box>
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
/**
 * "Which registration are you?" — asked of a signed-in pilot when the comp
 * holds registrations nobody has claimed.
 *
 * This exists because the alternative is worse than a question. An organiser
 * who typed a pilot's email wrongly used to get a SECOND roster entry for that
 * pilot, silently: their own entry empty, a self-made one carrying the track,
 * and a pilot count that feeds launch validity (S7F §10.1) counting a phantom.
 *
 * Nothing is preselected, deliberately. Preselecting the likeliest candidate
 * is exactly how somebody files a track against a stranger without noticing —
 * and the list is ORDERED by name likeness, which is a hint, never a verdict.
 */
export function RegistrationPicker({
  registration,
  chosen,
  onChoose,
  onIdentifier,
  identifierOverride,
  accountEmail,
}: {
  registration: RegistrationState | null;
  chosen: string | null;
  onChoose: (value: string) => void;
  onIdentifier: (v: { kind: IdentifierKind; value: string } | null) => void;
  identifierOverride: { kind: IdentifierKind; value: string } | null;
  accountEmail: string;
}) {
  const [showIdent, setShowIdent] = useState(false);
  const [kind, setKind] = useState<IdentifierKind>("civl_id");
  const [value, setValue] = useState("");

  // Null means "we do not know yet", which is NOT "you are new". Saying
  // nothing is the honest render.
  if (registration === null) {
    return <Loading>Checking your registration…</Loading>;
  }

  if (registration.state === "linked") {
    return (
      <p className="text-sm text-muted-foreground">
        Filing as <strong>{registration.comp_pilot.registered_pilot_name}</strong>{" "}
        ({registration.comp_pilot.pilot_class}).
      </p>
    );
  }

  if (registration.state === "new") {
    return (
      <p className="text-sm text-muted-foreground">
        You are not on this competition's roster yet
        {registration.may_register
          ? ". Submitting a track will add you."
          : ", and it does not accept pilots adding themselves — ask the organiser."}
      </p>
    );
  }

  const candidates = registration.candidates;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {registration.matched_by
          ? "That identifier is registered here. Confirm which entry is yours:"
          : "We could not tell which entry on this competition's roster is you. Pick yourself, so your track is not filed under a second entry:"}
      </p>
      <RadioGroup
        aria-label="Which registration are you?"
        value={chosen}
        onChange={onChoose}
        className="gap-1.5"
      >
        {candidates.map((cand) => (
          <Radio
            key={cand.comp_pilot_id}
            value={cand.comp_pilot_id}
            aria-label={[
              cand.registered_pilot_name,
              cand.pilot_class,
              cand.notify_email_masked ?? undefined,
            ]
              .filter(Boolean)
              .join(", ")}
            className="w-full items-baseline gap-2.5 rounded-md px-1 py-1"
          >
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span>{cand.registered_pilot_name}</span>
              <span className="text-xs text-muted-foreground">{cand.pilot_class}</span>
              {cand.notify_email_masked ? (
                <span className="text-xs text-muted-foreground">
                  {cand.notify_email_masked}
                </span>
              ) : null}
            </span>
          </Radio>
        ))}
        {registration.may_register ? (
          <Radio
            value={NEW_PILOT_SENTINEL}
            aria-label="None of these — register me as a new pilot"
            className="w-full items-baseline gap-2.5 rounded-md px-1 py-1"
          >
            <span>None of these — register me as a new pilot</span>
          </Radio>
        ) : null}
      </RadioGroup>

      {showIdent ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-2 sm:w-56">
            <Label id="reg-ident-kind">Find me by</Label>
            <SimpleSelect
              value={kind}
              onChange={(v) => setKind(v as IdentifierKind)}
              options={IDENTIFIER_KINDS}
              ariaLabel="Find me by"
              className="w-full"
            />
          </div>
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="reg-ident-value">
              {IDENTIFIER_KINDS.find((k) => k.value === kind)?.label}
            </Label>
            <Input
              id="reg-ident-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            onPress={() =>
              onIdentifier(value.trim() ? { kind, value: value.trim() } : null)
            }
          >
            Find me
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onPress={() => {
            setShowIdent(true);
            setValue(accountEmail && kind === "email" ? accountEmail : "");
          }}
        >
          I'm registered under a different name
        </Button>
      )}
      {identifierOverride && candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing on this roster answers to that. Pick yourself from the list, or
          ask the organiser.
        </p>
      ) : null}
    </div>
  );
}

export function TaskPicker({
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
export function SubmitFailure({ failure }: { failure: SubmitError }) {
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
export function TrackAccepted({
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
  const units = useUnits();

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
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(7rem,100%),1fr))] gap-x-6 gap-y-2 text-sm">
          <Fact label="Date" value={s.flight_date ?? "Not stated in the file"} />
          <Fact label="Take off" value={formatClockInZone(s.takeoff_at, zone)} />
          <Fact label="Landing" value={formatClockInZone(s.landing_at, zone)} />
          <Fact label="Airborne" value={formatDuration(s.duration_seconds)} />
          <Fact
            label="Track length"
            value={formatTrackDistance(s.track_length_m, units)}
          />
          <Fact
            label="Highest point"
            value={formatTrackAltitude(s.max_altitude_m, units)}
          />
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
          We emailed {result.notified.masked_to} to tell them
          {result.replaced
            ? " their track was replaced."
            : " a track was submitted for them."}
        </p>
      ) : null}
      {/* "no address" only. The other reason — the address IS the submitter's
          own — needs no line: telling somebody we did not email them about a
          thing they just did would be noise. */}
      {result.notified &&
      !result.notified.emailed &&
      result.notified.reason === "no_registered_email" ? (
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

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
