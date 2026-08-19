/**
 * SettingsForm — the form wrapper for a settings sub-page: an explicit Save
 * (matching the /settings profile precedent — these are scoring inputs, not
 * preferences, so nothing saves until the admin says so), plus the
 * unsaved-changes guard so edits can't be lost to a stray tap on a link.
 *
 * Save stays enabled even when clean: an untouched Save is meaningful (the
 * server counts any settings save as "settings reviewed" for the setup
 * guide). The dirty hint tells the reader when there is genuinely something
 * to save.
 */
import { Form } from "react-aria-components";
import { Button } from "@/react/rac/button";
import { useUnsavedChangesGuard } from "@/react/lib/use-unsaved-changes-guard";

export function SettingsForm({
  onSave,
  saving,
  dirty,
  children,
}: {
  /** Builds and sends the sub-page's PATCH; the caller owns the payload. */
  onSave: () => Promise<void> | void;
  saving: boolean;
  /** Arms the navigation guard and shows the unsaved hint. */
  dirty: boolean;
  children: React.ReactNode;
}) {
  useUnsavedChangesGuard(dirty, {
    title: "Discard changes?",
    message: "This page has unsaved changes. Leaving will discard them.",
  });

  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        void onSave();
      }}
      className="flex flex-col gap-6"
    >
      {children}
      <div className="flex items-center gap-3">
        <Button type="submit" isPending={saving} pendingLabel="Saving">
          Save
        </Button>
        {/* The dirty hint doubles as the explanation for what Save will do;
            role=status so the state change is announced. */}
        <span role="status" className="text-sm text-muted-foreground">
          {dirty && !saving ? "Unsaved changes" : ""}
        </span>
      </div>
    </Form>
  );
}
