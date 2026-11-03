/**
 * The kit's form: everything that happens between pressing Save and the
 * save succeeding, so no page writes it again.
 *
 * Every form used to do this by hand, two different ways, and both lost the
 * reader. Fifteen surfaces reported a failed save as a toast — gone in seconds,
 * tied to no field, easy for a screen reader to miss. The pilot sheet put its
 * error at the top of a body the organiser had scrolled past: on an iPhone,
 * Done spun, stopped, and nothing near the field they had just typed said why
 * (the server had refused an email that already belonged to someone on the
 * roster). This is the one place that is decided now, and
 * `e2e/forms.spec.ts` holds it on a phone and on a desktop.
 *
 * Built on React Aria's `Form`, which already does the part that is hard to
 * get right: an error shown under the field it belongs to, wired to it for a
 * screen reader. What it adds is the submit itself. The rules:
 *
 *   - **An error about a field goes under that field**, and the field is
 *     focused and scrolled to the middle of the page — clear of a sticky
 *     header and an on-screen keyboard. The form's own checks
 *     (`validate`) and the server's refusals land the same way: a refusal
 *     names its field (`{ error, field }`, competition-api's `validated()` and
 *     the routes that know better), and `fieldNames` maps the server's name
 *     for it onto the field's `name` here.
 *   - **An error about no field in particular has one fixed place**, the
 *     {@link FormErrorBanner} — beside the button that submits, and focus
 *     moves to it, scrolling it into view. Never a toast: toasts are for "Saved".
 *     A refusal can carry more than its sentence for that place — who to
 *     write to, a sign-in, when to try again — as `help`, which a form adds
 *     in `shapeRefusal` (the submit-track form's organiser `mailto:`). Under a
 *     field only the sentence is shown: the field IS the help there.
 *   - **One submit at a time**, and the submit button says so
 *     ({@link SubmitButton}). Enter submits, as a form does.
 *   - **A request that never got an answer** says {@link UNREACHABLE}, and
 *     keeps everything typed.
 *   - **Editing a field clears its error**, from the field's `input` or
 *     `change` event as React delivers it. React Aria keeps an error it was
 *     handed until it is handed a different one, so the form does this
 *     itself — and through React's own event, not a native listener: state
 *     set from a native listener re-rendered the field before React's handler
 *     ran, put the old value back, and swallowed what was typed.
 *
 * An action that is not a form — one control, pressed and sent: a row's
 * status menu, an Upload track button — follows the same rules through
 * {@link useAction} and {@link ActionErrorBanner}: there is no field, so every
 * refusal goes beside the control, and only its sentence is read (a `field`
 * the server sends — the upload routes' `file` — is ignored there). An action
 * INSIDE a form that is not its submit (the pilot page's Remove) uses
 * {@link useFormAction}, whose refusal goes in the form's own banner — focused
 * and scrolled to, like every other.
 *
 * A refusal a page decides itself, before or instead of asking the server (a
 * route that is not a task yet, a file that is not an IGC), is
 * {@link refusal}: the server's shape, so it lands by the same rule.
 *
 * `validationBehavior="aria"`, deliberately: the browser's own constraint
 * checks would refuse a submit before `validate` runs, in the browser's words
 * rather than ours.
 */
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Form as AriaForm } from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";
import { CardTitle, cardSurface } from "./card";

/** The words for a request that never got an answer. */
export const UNREACHABLE = "Could not reach GlideComp. Check your connection, then try again.";

/**
 * What a submit hands back: a fetch Response, or the API client's typed one.
 * Only the parts the form reads.
 */
export interface SubmitResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Why the server would not do it, and which field that was about. */
export interface Refusal {
  message: string;
  /** The server's name for the field, when the refusal is about one. */
  field?: string;
  /**
   * What the reader can do about it, beyond the sentence: who to ask, a
   * sign-in, when to try again. Shown under the message when the refusal
   * lands beside the submit ({@link FormErrorBanner}); never under a field.
   */
  help?: ReactNode;
}

/**
 * A refusal the page makes itself, in the shape the server's take — so it
 * lands by the same rule: under the field it names, or else in the banner.
 * Return it from `onSubmit`. `extra` is the rest of the body (a `code` a
 * form's `shapeRefusal` reads).
 */
export function refusal(
  error: string,
  extra: { field?: string } & Record<string, unknown> = {}
): SubmitResponse {
  const text = JSON.stringify({ ...extra, error });
  return {
    ok: false,
    status: 422,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}

/**
 * Read a refusal out of a response that was not ok, in any of the shapes the
 * API answers with: `{ error, field? }` (the standard), `{ errors: [{ error }] }`
 * (the bulk route), or plain text. A validation message arrives as
 * "field: message"; under the field itself the prefix only repeats the label,
 * so it is dropped.
 *
 * A body with none of those has no words for a person, and gets `fallback`:
 * a JSON object in some other shape (Better Auth's plugin routes answer
 * `{ code, message }`, written for a developer) is never shown as raw JSON.
 */
export async function readRefusal(
  res: {
    status: number;
    text(): Promise<string>;
  },
  fallback = `Save failed (${res.status}).`
): Promise<Refusal> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as {
      error?: unknown;
      field?: unknown;
      errors?: Array<{ error?: unknown }>;
    };
    const field = typeof body.field === "string" ? body.field : undefined;
    if (typeof body.error === "string") {
      const message =
        field && body.error.startsWith(`${field}: `)
          ? body.error.slice(field.length + 2)
          : body.error;
      return { message, field };
    }
    if (Array.isArray(body.errors)) {
      const messages = body.errors
        .map((e) => (typeof e.error === "string" ? e.error : ""))
        .filter(Boolean);
      if (messages.length > 0) return { message: messages.join(" ") };
    }
    if (typeof body === "object") return { message: fallback };
  } catch {
    // Not JSON: fall through to the text, if it is something a person can read.
  }
  const readable = text.trim() !== "" && text.length < 300 && !text.trimStart().startsWith("<");
  return { message: readable ? text.trim() : fallback };
}

interface FormState {
  /** A submit is in flight. */
  pending: boolean;
  /** Field name → message, shown under each field by React Aria. */
  fieldErrors: Record<string, string>;
  /** The error that belongs to no field, shown by FormErrorBanner. */
  formError: string | null;
  /** The refusal's `help`, shown with `formError`. */
  formErrorHelp: ReactNode;
  /**
   * Clear one field's error, for a field whose value changes without an
   * `input` event of its own (a choice picked from a combo box's list).
   */
  clearFieldError: (name: string) => void;
  /**
   * Show `message` in the form's banner and move focus to it — or clear the
   * banner with null. For {@link useFormAction}; a page reports through that,
   * so its refusal is focused the way the submit's is.
   */
  reportFormError: (message: string | null) => void;
}

const FormContext = createContext<FormState | null>(null);

/** The form's state, for anything rendered inside it. */
export function useFormState(): FormState {
  const state = useContext(FormContext);
  if (!state) throw new Error("useFormState() must be used inside a kit <Form>");
  return state;
}

/**
 * The form's state if there is a kit `Form` around, else null — for a kit
 * field that may be used outside one, and whose value changes without an
 * `input` event the form could hear (a date picker's segments, a chip that
 * fills a field), so it clears its own error.
 */
export function useOptionalFormState(): FormState | null {
  return useContext(FormContext);
}

/**
 * Where a reader types, ahead of anything they only press: a number field's
 * minus button comes before its input, and a date's segments are spinbuttons
 * rather than inputs.
 */
const TYPED = 'input:not([type="hidden"]), textarea, select, [role="spinbutton"]';
const FOCUSABLE = `${TYPED}, button`;

/**
 * The first thing in `form` a reader has to fix — the control itself, not the
 * field's wrapper (a radio group marks its group invalid, not a radio) — or
 * else the banner.
 */
function firstProblem(form: HTMLElement): HTMLElement | null {
  const field = form.querySelector<HTMLElement>('[data-invalid], [aria-invalid="true"]');
  if (field) {
    if (field.matches(FOCUSABLE)) return field;
    return (
      field.querySelector<HTMLElement>(TYPED) ??
      field.querySelector<HTMLElement>(FOCUSABLE) ??
      field
    );
  }
  return form.querySelector<HTMLElement>("[data-form-error]");
}

/**
 * Move focus to where a refusal is shown, every time `refused` is bumped —
 * once the page has stopped moving focus itself.
 *
 * It has to wait. An action pressed from a popover (a row's status menu) can
 * be refused while that popover is still animating shut, and a popover gives
 * focus back to its trigger as it goes — taking it straight off the refusal.
 * A confirm dialog (the pilot page's Remove, Settings' Revoke) does the same a
 * frame after it unmounts, and when its trigger sits in a table row, the
 * table then moves focus again, onto the row. So wait until nothing is
 * closing and focus has stopped moving, for two frames, then move it. A
 * second at most: past that, nothing is settling and the refusal has waited
 * long enough.
 *
 * A target folded away in a `<details>` (the scoring page's Advanced
 * settings) is unfolded, or there would be nothing to see or to focus; it is
 * centred in whatever scrolls it, which keeps it clear of a sticky header and
 * (once focus raises one) the keyboard.
 */
function useRevealOnRefusal(refused: number, find: () => HTMLElement | null): void {
  const findRef = useRef(find);
  findRef.current = find;
  useEffect(() => {
    if (refused === 0) return;
    let frame = 0;
    let settled = 0;
    let frames = 0;
    let focused = document.activeElement;
    const show = () => {
      const moved = document.activeElement !== focused;
      focused = document.activeElement;
      if (document.querySelector("[data-exiting]") || moved) settled = 0;
      else settled++;
      if (settled < 2 && ++frames < 60) {
        frame = requestAnimationFrame(show);
        return;
      }
      const target = findRef.current();
      if (!target) return;
      for (
        let fold = target.closest("details");
        fold;
        fold = fold.parentElement?.closest("details") ?? null
      ) {
        fold.open = true;
      }
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    };
    show();
    return () => cancelAnimationFrame(frame);
  }, [refused]);
}

/**
 * The field a refusal is about: the server's name for it, mapped through
 * `fieldNames`, or else the nearest field above it — a refusal about one item
 * of a list ("admin_emails.1") is about the field the list is typed in.
 */
function fieldFor(
  form: HTMLElement | null,
  field: string | undefined,
  fieldNames: Record<string, string> | undefined
): string | undefined {
  if (!form || !field) return undefined;
  const parts = field.split(".");
  for (let n = parts.length; n > 0; n--) {
    const path = parts.slice(0, n).join(".");
    const name = fieldNames?.[path] ?? path;
    if (form.querySelector(`[name="${CSS.escape(name)}"]`)) return name;
  }
  return undefined;
}

/** The refusal in a response that was not ok, shaped by the form if it asks. */
async function formRefusal(
  res: SubmitResponse,
  fallback: string | undefined,
  shapeRefusal: ((refusal: Refusal, body: unknown) => Refusal) | undefined
): Promise<Refusal> {
  if (!shapeRefusal) return readRefusal(res, fallback);
  // Read once, for both readRefusal and the form's own reading of it.
  const text = await res.text().catch(() => "");
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the form is handed null.
  }
  return shapeRefusal(
    await readRefusal({ status: res.status, text: async () => text }, fallback),
    body
  );
}

export function Form({
  onSubmit,
  onSuccess,
  validate,
  fieldNames,
  shapeRefusal,
  fallback,
  onPendingChange,
  className,
  children,
}: {
  /**
   * Send it. Return the response, or nothing when there was nothing to send
   * (an untouched form) — `onSuccess` still runs. A thrown error means the
   * request never got an answer. Left out, the form sends nothing: a page
   * whose Done only checks its fields and keeps them (a draft's own pages).
   */
  onSubmit?: () => Promise<SubmitResponse | undefined | void>;
  /**
   * After an ok response (or nothing sent). The submit is still in flight
   * until this settles, so the button stays busy while it reads the answer
   * or reloads, and a second press cannot send the same thing again.
   * Throwing here is a bug, not a refusal.
   */
  onSuccess?: (res: SubmitResponse | undefined) => void | Promise<void>;
  /**
   * The form's own checks, run before anything is sent: field name → message,
   * with a falsy value meaning that field is fine.
   */
  validate?: () => Record<string, string | undefined | null | false>;
  /** The server's field names, mapped onto this form's field `name`s. */
  fieldNames?: Record<string, string>;
  /**
   * Reshape a refusal before it is shown, from the response's JSON body (null
   * when it was not JSON): name the field it is about when the server's body
   * says so another way (a `code`), or give it `help` for the pinned error.
   */
  shapeRefusal?: (refusal: Refusal, body: unknown) => Refusal;
  /**
   * The form's own words for a refusal that carries none a person can read
   * (see {@link readRefusal}). Defaults to "Save failed (status)."
   */
  fallback?: string;
  /**
   * Told when a submit starts and when it is over — for state above the form
   * that must know a save is in flight (a draft editor's guard stands down).
   */
  onPendingChange?: (pending: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const pendingChange = useRef(onPendingChange);
  pendingChange.current = onPendingChange;
  useEffect(() => {
    pendingChange.current?.(pending);
  }, [pending]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormErrorOnly] = useState<string | null>(null);
  const [formErrorHelp, setFormErrorHelp] = useState<ReactNode>(null);
  /** The pinned error, and its help (none, unless a refusal brought some). */
  const setFormError = (message: string | null, help: ReactNode = null) => {
    setFormErrorOnly(message);
    setFormErrorHelp(help);
  };
  // Bumped after every refusal, so the focus move runs after the errors it is
  // moving to have rendered — and runs again for the same error twice.
  const [refused, setRefused] = useState(0);
  const inFlight = useRef(false);

  /** One field's error gone; also handed to fields through useFormState. */
  const clearFieldError = (name: string) =>
    setFieldErrors((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  /**
   * Editing a field clears its error. Bubbled up through React (see the note
   * at the top: never from a native listener), from every kind of field the
   * kit has, without each one being told.
   */
  const clearEdited = (e: { target: EventTarget | null }) => {
    const target = e.target as HTMLInputElement | null;
    // A number field's name is on a hidden input beside the one typed in,
    // which carries it as `data-field-name` instead (rac/field.tsx).
    const name = target?.name || target?.dataset?.fieldName;
    if (name) clearFieldError(name);
  };

  useRevealOnRefusal(refused, () => (formRef.current ? firstProblem(formRef.current) : null));

  /** An error for the banner, focused once it has rendered. */
  const refuse = (message: string, help?: ReactNode) => {
    setFormError(message, help);
    setRefused((n) => n + 1);
  };

  async function submit() {
    if (inFlight.current) return;
    setFormError(null);

    const own = Object.fromEntries(
      Object.entries(validate?.() ?? {}).filter((e): e is [string, string] => !!e[1])
    );
    if (Object.keys(own).length > 0) {
      setFieldErrors(own);
      setRefused((n) => n + 1);
      return;
    }
    setFieldErrors({});

    // In flight until the answer has been read AND acted on: released only
    // after `onSuccess` settles, so nothing it awaits leaves the button live.
    inFlight.current = true;
    setPending(true);
    try {
      let res: SubmitResponse | undefined;
      try {
        res = (await onSubmit?.()) ?? undefined;
      } catch {
        refuse(UNREACHABLE);
        return;
      }
      if (res && !res.ok) {
        const shown = await formRefusal(res, fallback, shapeRefusal);
        const name = fieldFor(formRef.current, shown.field, fieldNames);
        if (name) {
          setFieldErrors({ [name]: shown.message });
          setRefused((n) => n + 1);
        } else refuse(shown.message, shown.help);
        return;
      }
      await onSuccess?.(res);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <FormContext.Provider
      value={{
        pending,
        fieldErrors,
        formError,
        formErrorHelp,
        clearFieldError,
        reportFormError: (message) => (message === null ? setFormError(null) : refuse(message)),
      }}
    >
      <AriaForm
        ref={formRef}
        validationBehavior="aria"
        validationErrors={fieldErrors}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className={className}
      >
        {/* `contents`: it exists only to hear edits bubble, and must not be a
            box in the form's own layout (often a flex column). */}
        <div className="contents" onInput={clearEdited} onChange={clearEdited}>
          {children}
        </div>
      </AriaForm>
    </FormContext.Provider>
  );
}

/**
 * The form's submit: busy while a submit is in flight, and never a second
 * submit on top of the first.
 */
export function SubmitButton({
  children,
  pendingLabel = "Saving",
  className,
  autoFocus,
  isDisabled,
}: {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  autoFocus?: boolean;
  /** Nothing to submit yet — the waypoints page's Save with no changes. */
  isDisabled?: boolean;
}) {
  const { pending } = useFormState();
  return (
    <Button
      type="submit"
      isDisabled={isDisabled}
      isPending={pending}
      pendingLabel={pendingLabel}
      className={className}
      autoFocus={autoFocus}
    >
      {children}
    </Button>
  );
}

/**
 * The error that belongs to no field. Place it beside the submit — under a
 * page's header when Done is at the top, above Save when Save is at the foot.
 * Focus moves here when it appears (scrolling it into view), so it is read out
 * as well as seen.
 *
 * `title` heads every error shown here, for a form that names what failed
 * ("We could not accept that track"). A refusal's `help` follows its message.
 */
export function FormErrorBanner({
  className,
  title,
}: {
  className?: string;
  title?: ReactNode;
}) {
  const { formError, formErrorHelp } = useFormState();
  if (!formError) return null;
  return (
    <div className={className}>
      <Alert variant="destructive" data-form-error tabIndex={-1} className="outline-none">
        {title ? <AlertTitle>{title}</AlertTitle> : null}
        <AlertDescription>
          {formErrorHelp ? (
            <>
              <p>{formError}</p>
              {formErrorHelp}
            </>
          ) : (
            formError
          )}
        </AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * What `run` takes: the request, and options — the action's own words for a
 * wordless refusal, and `key`, naming which of several like controls (a row's
 * Revoke) was pressed, so only that one shows busy ({@link ActionState.pendingKey}).
 *
 * Anything that must finish before the action counts as done — reloading the
 * list it changed — goes inside `send`, after the response is ok: the press
 * is busy until `send` resolves, so a second press cannot repeat it.
 */
export type RunAction = (
  send: () => Promise<SubmitResponse>,
  options?: { fallback?: string; key?: string }
) => Promise<SubmitResponse | null>;

/**
 * One press at a time, a refusal read in the reader's words, and a request
 * that never got an answer said as {@link UNREACHABLE} — the part
 * {@link useAction} and {@link useFormAction} share. They differ only in
 * where a refusal is shown.
 */
function useRun(show: (message: string | null) => void): {
  pending: boolean;
  pendingKey: string | null;
  run: RunAction;
} {
  const [pending, setPending] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const inFlight = useRef(false);
  const run: RunAction = async (send, options) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setPendingKey(options?.key ?? null);
    show(null);
    try {
      const res = await send();
      if (!res.ok) {
        show((await readRefusal(res, options?.fallback)).message);
        return null;
      }
      return res;
    } catch {
      show(UNREACHABLE);
      return null;
    } finally {
      inFlight.current = false;
      setPending(false);
      setPendingKey(null);
    }
  };
  return { pending, pendingKey, run };
}

/**
 * The same rules for an action that is not a form: one control, pressed, and
 * sent — a row's status menu, an Upload track button, a menu item. There is
 * no field for a refusal to go under, so it goes in one fixed place beside
 * the control ({@link ActionErrorBanner}), never in a toast; one press runs at
 * a time; a request that never got an answer says {@link UNREACHABLE}. The
 * next press clears it.
 *
 * `run` hands back the response when the server said yes, and null when it
 * did not (the refusal is already showing) — or when another press is still
 * in flight, which it ignores. Its `fallback` is the action's own words for a
 * refusal that carries none a person can read (see {@link readRefusal}).
 * `refuse` is for a check made before anything is sent — a file that is not
 * an IGC.
 */
export interface ActionState {
  pending: boolean;
  /** The `key` the press in flight was run with, or null. */
  pendingKey: string | null;
  error: string | null;
  /** Bumped on every refusal, so the banner takes focus again for the same words. */
  refused: number;
  refuse: (message: string) => void;
  run: RunAction;
}

export function useAction(): ActionState {
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(0);

  const show = (message: string | null) => {
    setError(message);
    if (message !== null) setRefused((n) => n + 1);
  };
  const { pending, pendingKey, run } = useRun(show);

  return { pending, pendingKey, error, refused, refuse: show, run };
}

/**
 * An action inside a kit `Form` that is not its submit — the pilot page's
 * Remove, the roster import's Add classes. Its refusal goes in the form's own
 * banner ({@link FormErrorBanner}), focused and scrolled to, where every other
 * error on that page is; otherwise as {@link useAction}.
 */
export function useFormAction(): {
  pending: boolean;
  pendingKey: string | null;
  run: RunAction;
} {
  const { reportFormError } = useFormState();
  return useRun(reportFormError);
}

/**
 * An action's refusal, where {@link FormErrorBanner} puts a form's: beside the
 * control that was pressed. Focus moves here when it appears, scrolling it
 * into view, so it is read out as well as seen.
 */
export function ActionErrorBanner({
  action,
  className,
}: {
  action: ActionState;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRevealOnRefusal(action.refused, () => ref.current);
  if (!action.error) return null;
  return (
    <div className={className}>
      <Alert
        ref={ref}
        variant="destructive"
        data-action-error
        tabIndex={-1}
        className="outline-none"
      >
        <AlertDescription>{action.error}</AlertDescription>
      </Alert>
    </div>
  );
}

/**
 * A group of fields under a heading — a card of them, the way the settings
 * pages group theirs, so a long form reads as a few named parts rather than
 * one column of boxes. A `group` labelled by its heading: a screen reader
 * announces "Contact, group" on the way in, and a heading-to-heading jump
 * lands on each part.
 *
 * Nothing in it folds away. A section that collapsed hid its fields from the
 * reader scanning for them, and from the kit's focus move when one of them
 * was the field with the problem.
 */
export function FormSection({
  title,
  children,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className={cn(cardSurface, "flex flex-col gap-4 p-4", className)}>
      <CardTitle as="h3" id={id}>
        {title}
      </CardTitle>
      {children}
    </div>
  );
}
