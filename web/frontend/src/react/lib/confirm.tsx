/**
 * Promise-based confirm/alert dialogs — the React equivalent of feedback.ts's
 * confirmDialog()/alertDialog(). Pages call `const confirm = useConfirm()` and
 * `await confirm({...})`.
 *
 * This module is the CONTEXT only, deliberately free of any UI imports: the
 * provider that renders the dialog lives in `rac/confirm.tsx` (mounted once,
 * app-wide, by routes.tsx). Keeping the two apart is what lets the provider be
 * a react-aria-components alertdialog without every `useConfirm()` caller —
 * including plain non-RAC pages — importing the kit.
 */
import { createContext, useContext } from "react";

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

/** Supplied by rac/confirm.tsx's ConfirmProvider. */
export const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
