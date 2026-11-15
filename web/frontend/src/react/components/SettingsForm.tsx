/**
 * SettingsForm — a page that is a form: the bar with Cancel on the left and
 * the commit button on the right, then the fields in the narrow column.
 *
 * It is the kit `Form` (rac/form.tsx), which owns what happens when the commit
 * does not work: the page's own checks (`validate`) and the server's refusals
 * land under the field they are about — every field carries a `name`, and
 * `fieldNames` maps the server's name for a field onto it where the two
 * differ — and an error about no field is shown in the banner at the top of
 * the column, focused and scrolled into view. A failed save is never a toast.
 *
 * The form wraps the bar, because the commit button is in it. The form
 * element is `display: contents`, so the bar still sticks to the page.
 *
 * ## When the commit button is live (issue #863)
 *
 * Only when there is something to commit: `dirty` on a form that edits,
 * `canCommit` (the required fields) on a form that makes something new. Until
 * 2026-11 a settings page kept Save live with nothing changed.
 *
 * ## Leaving
 *
 * Cancel asks before it throws a change away, then leaves for the page above
 * (`lib/leave.ts`). The unsaved-changes guard asks the same question of an
 * in-app link, a reload and a tab close — never of Back.
 */
import type { ReactNode } from "react";
import {
  Form,
  FormErrorBanner,
  SubmitButton,
  type Refusal,
  type SubmitResponse,
} from "@/react/rac/form";
import { Page, PageBar, commitClass, type BarAction } from "@/react/rac/page-bar";
import type { Crumb } from "@/react/lib/crumbs";
import { useConfirm } from "@/react/lib/confirm";
import { useLeave } from "@/react/lib/leave";
import { useUnsavedChangesGuard } from "@/react/lib/use-unsaved-changes-guard";

export function SettingsForm({
  crumbs,
  title,
  fullTitle,
  description,
  actions,
  leaveTo,
  onSubmit,
  onSuccess,
  validate,
  fieldNames,
  shapeRefusal,
  fallback,
  dirty,
  canCommit = dirty,
  submitLabel = "Save",
  pendingLabel,
  guard = {
    title: "Discard changes?",
    message: "This page has unsaved changes. Leaving will discard them.",
  },
  errorTitle,
  children,
}: {
  /** The pages above this one, from the builders in lib/crumbs.ts. */
  crumbs: Crumb[];
  /** One line: the bar's title and the page's `<h1>`. */
  title: string;
  /** The name in full, where the title is a short form of it. */
  fullTitle?: string;
  description?: ReactNode;
  /** The page's other actions, under ⋯ (Scoring's "Reset to defaults"). */
  actions?: BarAction[];
  /** Where Cancel leaves for. Defaults to the page above (the last crumb). */
  leaveTo?: string;
  /** Builds and sends the request; the caller owns the payload. */
  onSubmit?: () => Promise<SubmitResponse | undefined | void>;
  /** After the server said yes, with its answer. */
  onSuccess?: (res: SubmitResponse | undefined) => void | Promise<void>;
  /** The page's own checks: field name → message (see rac/form.tsx). */
  validate?: () => Record<string, string | undefined | null | false>;
  /** The server's field names, mapped onto this page's field `name`s. */
  fieldNames?: Record<string, string>;
  /** See rac/form.tsx. */
  shapeRefusal?: (refusal: Refusal, body: unknown) => Refusal;
  /** The form's own words for a refusal that carries none (rac/form.tsx). */
  fallback?: string;
  /** There are changes: arms the guard, and makes Cancel ask first. */
  dirty: boolean;
  /**
   * There is something to commit. Defaults to `dirty`, which is right for a
   * form that edits; a form that makes something new passes its required
   * fields ("a name has been typed").
   */
  canCommit?: boolean;
  /** Save, Create, Add: see "Button wording" in CLAUDE.md. */
  submitLabel?: string;
  pendingLabel?: string;
  /** The question Cancel and the unsaved-changes guard ask. */
  guard?: { title: string; message: string };
  /** Heads every error in the banner ("We could not accept that track"). */
  errorTitle?: ReactNode;
  children: ReactNode;
}) {
  const confirm = useConfirm();
  const leave = useLeave();
  useUnsavedChangesGuard(dirty, guard);
  const back = leaveTo ?? crumbs[crumbs.length - 1]?.to ?? "/comp";

  const cancel = async () => {
    if (
      dirty &&
      !(await confirm({
        title: guard.title,
        message: guard.message,
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        destructive: true,
      }))
    )
      return;
    leave(back);
  };

  return (
    <Form
      onSubmit={onSubmit}
      onSuccess={onSuccess}
      validate={validate}
      fieldNames={fieldNames}
      shapeRefusal={shapeRefusal}
      fallback={fallback}
      className="contents"
    >
      <Page
        bar={
          <PageBar
            title={title}
            fullTitle={fullTitle}
            trail={crumbs}
            cancel={() => void cancel()}
            actions={actions}
            commit={
              // isDisabled for "nothing to commit" (a standing state); the
              // kit's pending state for the request in flight.
              <SubmitButton
                className={commitClass}
                isDisabled={!canCommit}
                pendingLabel={pendingLabel}
              >
                {submitLabel}
              </SubmitButton>
            }
          />
        }
        className="flex flex-col gap-6"
      >
        <FormErrorBanner title={errorTitle} />
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        {children}
      </Page>
    </Form>
  );
}
