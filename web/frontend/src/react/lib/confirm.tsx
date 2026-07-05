/**
 * Promise-based confirm/alert dialogs on Base UI AlertDialog — the React
 * equivalent of feedback.ts's confirmDialog()/alertDialog(). Pages call
 * `const confirm = useConfirm()` and `await confirm({...})`.
 */
import { createContext, useContext, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Alert mode: single OK button, always resolves true. */
  alert?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

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
      <AlertDialog.Root
        open={opts !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Backdrop />
          <AlertDialog.Popup>
            <AlertDialog.Title>{opts?.title}</AlertDialog.Title>
            {opts?.message ? (
              <AlertDialog.Description>{opts.message}</AlertDialog.Description>
            ) : null}
            {opts?.alert ? (
              <button type="button" autoFocus onClick={() => finish(true)}>
                OK
              </button>
            ) : (
              <>
                <button type="button" onClick={() => finish(false)}>
                  {opts?.cancelLabel ?? "Cancel"}
                </button>
                <button type="button" autoFocus onClick={() => finish(true)}>
                  {opts?.confirmLabel ?? "Confirm"}
                </button>
              </>
            )}
          </AlertDialog.Popup>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}
