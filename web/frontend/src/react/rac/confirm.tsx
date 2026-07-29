/**
 * The app's confirm/alert provider: supplies lib/confirm.tsx's ConfirmContext,
 * so every `useConfirm()` in the app resolves to this react-aria-components
 * alertdialog. Mounted once, app-wide, by routes.tsx — pages don't wrap
 * themselves (they did while the global provider was still the Base UI one).
 *
 * SSR-safe: renders nothing until a dialog is actually requested.
 */
import { useRef, useState } from "react";
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from "../lib/confirm";
import { Button } from "./button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle, Modal } from "./dialog";

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
