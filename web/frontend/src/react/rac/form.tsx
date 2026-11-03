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
 * the server sends — the upload routes' `file` — is ignored there).
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
 * Read a refusal out of a response that was not ok, in any of the shapes the
 * API answers with: `{ error, field? }` (the standard), `{ errors: [{ error }] }`
 * (the bulk route), or plain text. A validation message arrives as
 * "field: message"; under the field itself the prefix only repeats the label,
 * so it is dropped.
 */
export async function readRefusal(res: {
  status: number;
  text(): Promise<string>;
}): Promise<Refusal> {
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
  } catch {
    // Not JSON: fall through to the text, if it is something a person can read.
  }
  const readable = text.trim() !== "" && text.length < 300 && !text.trimStart().startsWith("<");
  return { message: readable ? text.trim() : `Save failed (${res.status}).` };
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
   * Report an error in the form's one fixed place — for an action inside the
   * form that is not its submit (the pilot page's Remove), so it is seen
   * where every other error is. `help` as a refusal's.
   */
  setFormError: (message: string | null, help?: ReactNode) => void;
  /**
   * Clear one field's error, for a field whose value changes without an
   * `input` event of its own (a choice picked from a combo box's list).
   */
  clearFieldError: (name: string) => void;
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
 * `input` event the form could hear (a date picker's segments), so it clears
 * its own error.
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

export function Form({
  onSubmit,
  onSuccess,
  validate,
  fieldNames,
  shapeRefusal,
  className,
  children,
}: {
  /**
   * Send it. Return the response, or nothing when there was nothing to send
   * (an untouched form) — `onSuccess` still runs. A thrown error means the
   * request never got an answer.
   */
  onSubmit: () => Promise<SubmitResponse | undefined | void>;
  /** After an ok response (or nothing sent). Throwing here is a bug, not a refusal. */
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
  className?: string;
  children: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
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

  useEffect(() => {
    if (refused === 0 || !formRef.current) return;
    const target = firstProblem(formRef.current);
    if (!target) return;
    // A field folded away in a <details> (the scoring page's Advanced
    // settings) is unfolded, or there would be nothing to see or to focus.
    for (
      let fold = target.closest("details");
      fold;
      fold = fold.parentElement?.closest("details") ?? null
    ) {
      fold.open = true;
    }
    // Centre it in whatever scrolls it, which keeps it clear of a sticky
    // header and (once focus raises one) the keyboard.
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [refused]);

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

    inFlight.current = true;
    setPending(true);
    let res: SubmitResponse | undefined;
    try {
      res = (await onSubmit()) ?? undefined;
    } catch {
      setFormError(UNREACHABLE);
      setRefused((n) => n + 1);
      return;
    } finally {
      inFlight.current = false;
      setPending(false);
    }

    if (res && !res.ok) {
      let refusal: Refusal;
      if (shapeRefusal) {
        // Read once, for both readRefusal and the form's own reading of it.
        const text = await res.text().catch(() => "");
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          // Not JSON: the form is handed null.
        }
        refusal = shapeRefusal(
          await readRefusal({ status: res.status, text: async () => text }),
          body
        );
      } else {
        refusal = await readRefusal(res);
      }
      const name = fieldFor(formRef.current, refusal.field, fieldNames);
      if (name) setFieldErrors({ [name]: refusal.message });
      else setFormError(refusal.message, refusal.help);
      setRefused((n) => n + 1);
      return;
    }
    await onSuccess?.(res);
  }

  return (
    <FormContext.Provider
      value={{ pending, fieldErrors, formError, formErrorHelp, setFormError, clearFieldError }}
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
 * The same rules for an action that is not a form: one control, pressed, and
 * sent — a row's status menu, an Upload track button, a menu item. There is
 * no field for a refusal to go under, so it goes in one fixed place beside
 * the control ({@link ActionErrorBanner}), never in a toast; one press runs at
 * a time; a request that never got an answer says {@link UNREACHABLE}. The
 * next press clears it.
 *
 * `run` hands back the response when the server said yes, and null when it
 * did not (the refusal is already showing). `refuse` is for a check made
 * before anything is sent — a file that is not an IGC.
 */
export interface ActionState {
  pending: boolean;
  error: string | null;
  /** Bumped on every refusal, so the banner takes focus again for the same words. */
  refused: number;
  refuse: (message: string) => void;
  run: (send: () => Promise<SubmitResponse>) => Promise<SubmitResponse | null>;
}

export function useAction(): ActionState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(0);
  const inFlight = useRef(false);

  const refuse = (message: string) => {
    setError(message);
    setRefused((n) => n + 1);
  };

  async function run(send: () => Promise<SubmitResponse>): Promise<SubmitResponse | null> {
    if (inFlight.current) return null;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await send();
      if (!res.ok) {
        refuse((await readRefusal(res)).message);
        return null;
      }
      return res;
    } catch {
      refuse(UNREACHABLE);
      return null;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return { pending, error, refused, refuse, run };
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
  useEffect(() => {
    if (action.refused === 0) return;
    let frame = 0;
    let settled = 0;
    // An action pressed from a popover (a row's status menu) can be refused
    // while that popover is still animating shut, and a popover gives focus
    // back to its trigger as it goes — taking it straight off the refusal.
    // So wait until nothing is closing, and a frame after, then move focus.
    const show = () => {
      if (document.querySelector("[data-exiting]")) settled = 0;
      else settled++;
      if (settled < 2) {
        frame = requestAnimationFrame(show);
        return;
      }
      ref.current?.scrollIntoView({ block: "center" });
      ref.current?.focus({ preventScroll: true });
    };
    show();
    return () => cancelAnimationFrame(frame);
  }, [action.refused]);
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
