/**
 * What a draft editor says about its draft at the top of its page — the
 * waypoints list and the route editor (lib/draft-editor.ts): that the saved
 * copy moved under the edits, and that the browser is not keeping them.
 */
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { cn } from "@/react/lib/utils";

export function DraftNotices({
  serverChanged,
  notKept,
  changed,
  className,
}: {
  serverChanged: boolean;
  notKept: boolean;
  /**
   * The saved copy moved under a draft with edits in it: another organiser
   * (or another tab) saved meanwhile. The draft is the reader's work and
   * stays; this says what Save would do to what they saved.
   */
  changed: ReactNode;
  className?: string;
}) {
  if (!serverChanged && !notKept) return null;
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {serverChanged ? (
        <Alert>
          <AlertDescription>{changed}</AlertDescription>
        </Alert>
      ) : null}
      {/* Storage refused the draft (site data blocked, or full): the editor's
          pages still share it in this tab, but a reload will not find it. */}
      {notKept ? (
        <Alert>
          <AlertDescription>
            This browser isn’t storing your changes, so reloading the page will lose them.
            Save before you reload or close it.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
