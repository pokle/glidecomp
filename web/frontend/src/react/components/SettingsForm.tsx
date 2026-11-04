/**
 * SettingsForm — the form wrapper for a settings sub-page: an explicit Save
 * (matching the /settings profile precedent — these are scoring inputs, not
 * preferences, so nothing saves until the admin says so), plus the
 * unsaved-changes guard so edits can't be lost to a stray tap on a link.
 *
 * It is the kit `Form` (rac/form.tsx), which owns what happens when Save does
 * not work: the page's own checks (`validate`) and the server's refusals land
 * under the field they are about — every field carries a `name`, and
 * `fieldNames` maps the server's name for a field onto it where the two
 * differ — and an error about no field is shown beside Save, the button the
 * reader just pressed. A failed save is never a toast.
 *
 * Save stays enabled even when clean: an untouched Save is meaningful (the
 * server counts any settings save as "settings reviewed" for the setup
 * guide). The dirty hint tells the reader when there is genuinely something
 * to save.
 */
import type { ReactNode } from "react";
import {
  Form,
  FormErrorBanner,
  SubmitButton,
  useFormState,
  type SubmitResponse,
} from "@/react/rac/form";
import { useUnsavedChangesGuard } from "@/react/lib/use-unsaved-changes-guard";

export function SettingsForm({
  onSubmit,
  onSuccess,
  validate,
  fieldNames,
  dirty,
  submitLabel = "Save",
  pendingLabel,
  disableWhenClean = false,
  guard = {
    title: "Discard changes?",
    message: "This page has unsaved changes. Leaving will discard them.",
  },
  children,
}: {
  /** Builds and sends the sub-page's PATCH; the caller owns the payload. */
  onSubmit: () => Promise<SubmitResponse>;
  /** After the server said yes, with its answer. */
  onSuccess: (res: SubmitResponse | undefined) => void | Promise<void>;
  /** The page's own checks: field name → message (see rac/form.tsx). */
  validate?: () => Record<string, string | undefined | null | false>;
  /** The server's field names, mapped onto this page's field `name`s. */
  fieldNames?: Record<string, string>;
  /** Arms the navigation guard and shows the unsaved hint. */
  dirty: boolean;
  submitLabel?: string;
  pendingLabel?: string;
  /**
   * Save disabled while there is nothing to save — the profile, where an
   * untouched Save means nothing (a settings page's does: see above).
   */
  disableWhenClean?: boolean;
  /** The unsaved-changes guard's question. */
  guard?: { title: string; message: string };
  children: ReactNode;
}) {
  useUnsavedChangesGuard(dirty, guard);

  return (
    <Form
      onSubmit={onSubmit}
      onSuccess={onSuccess}
      validate={validate}
      fieldNames={fieldNames}
      className="flex flex-col gap-6"
    >
      {children}
      <div className="flex flex-col gap-3">
        <FormErrorBanner />
        <div className="flex items-center gap-3">
          {/* isDisabled for "nothing to save" (a standing state); the kit's
              pending state for the save in flight — two different things. */}
          <SubmitButton isDisabled={disableWhenClean && !dirty} pendingLabel={pendingLabel}>
            {submitLabel}
          </SubmitButton>
          <UnsavedHint dirty={dirty} />
        </div>
      </div>
    </Form>
  );
}

/**
 * The dirty hint doubles as the explanation for what Save will do; role=status
 * so the state change is announced.
 */
function UnsavedHint({ dirty }: { dirty: boolean }) {
  const { pending } = useFormState();
  return (
    <span role="status" className="text-sm text-muted-foreground">
      {dirty && !pending ? "Unsaved changes" : ""}
    </span>
  );
}
