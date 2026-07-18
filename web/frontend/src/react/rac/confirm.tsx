/**
 * RAC-based confirm/alert provider. Supplies the SAME ConfirmContext as
 * lib/confirm.tsx, so wrapping a subtree in <RacConfirmProvider> makes every
 * useConfirm() inside it resolve to a react-aria-components alertdialog while
 * the rest of the app keeps the Base UI one. Promise API unchanged.
 */
import { useRef, useState } from "react";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "../lib/confirm";
import { Button } from "./button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle, Modal } from "./dialog";

export function RacConfirmProvider({ children }: { children: React.ReactNode }) {
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
      <Modal
        isOpen={opts !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        // Alert dialogs are decisions: no click-outside dismissal (Esc works
        // via the dialog's keyboard handling below).
        isDismissable={false}
        isKeyboardDismissDisabled={false}
      >
        <Dialog role="alertdialog">
          <DialogHeader>
            <DialogTitle>{opts?.title}</DialogTitle>
            {opts?.message ? (
              <p className="text-sm text-muted-foreground">{opts.message}</p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            {opts?.alert ? (
              <Button autoFocus onPress={() => finish(true)}>
                OK
              </Button>
            ) : (
              <>
                <Button variant="outline" onPress={() => finish(false)}>
                  {opts?.cancelLabel ?? "Cancel"}
                </Button>
                <Button
                  autoFocus
                  variant={opts?.destructive ? "destructive" : "default"}
                  onPress={() => finish(true)}
                >
                  {opts?.confirmLabel ?? "Confirm"}
                </Button>
              </>
            )}
          </DialogFooter>
        </Dialog>
      </Modal>
    </ConfirmContext.Provider>
  );
}
