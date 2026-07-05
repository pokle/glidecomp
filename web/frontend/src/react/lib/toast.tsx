/**
 * App-wide toasts built on Base UI Toast. `toast` mirrors the vanilla
 * feedback.ts API (success/error/info/warning) so page code ports over
 * unchanged; the manager lets non-component code raise toasts too.
 */
import { Toast } from "@base-ui/react/toast";

export const toastManager = Toast.createToastManager();

function show(type: "success" | "error" | "info" | "warning", description: string) {
  toastManager.add({ type, description });
}

export const toast = {
  success: (message: string) => show("success", message),
  error: (message: string) => show("error", message),
  info: (message: string) => show("info", message),
  warning: (message: string) => show("warning", message),
};

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((t) => (
    <Toast.Root key={t.id} toast={t}>
      <Toast.Content>
        {t.type ? <Toast.Title>{t.type}</Toast.Title> : null}
        <Toast.Description />
      </Toast.Content>
      <Toast.Close aria-label="Close notification">×</Toast.Close>
    </Toast.Root>
  ));
}

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport>
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
