/**
 * Promise-based confirm/alert dialogs on the shadcn AlertDialog — the React
 * equivalent of feedback.ts's confirmDialog()/alertDialog(). Pages call
 * `const confirm = useConfirm()` and `await confirm({...})`.
 */
import { createContext, useContext, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/react/ui/alert-dialog";
import { Button } from "@/react/ui/button";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Alert mode: single OK button, always resolves true. */
  alert?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

/** Exported so an inner provider (e.g. rac/confirm.tsx) can shadow it. */
export const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolveRef = useRef<(value: boolean) => void>(() => {});

  const confirm: ConfirmFn = (options) =>
    new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setOpts(options);
    });

  function finish(value: boolean) {
    resolveRef.current(value);
    setOpts(null);
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={opts !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{opts?.title}</AlertDialogTitle>
            {opts?.message ? (
              <AlertDialogDescription>{opts.message}</AlertDialogDescription>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            {opts?.alert ? (
              <Button type="button" autoFocus onClick={() => finish(true)}>
                OK
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => finish(false)}>
                  {opts?.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  type="button"
                  autoFocus
                  variant={opts?.destructive ? "destructive" : "default"}
                  onClick={() => finish(true)}
                >
                  {opts?.confirmLabel ?? "Confirm"}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
