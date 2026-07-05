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
    <Toast.Root key={t.id} toast={t} className="Toast-root" data-type={t.type}>
      <Toast.Content className="Toast-content">
        <div className="Toast-text">
          {t.type ? <Toast.Title className="Toast-title">{t.type}</Toast.Title> : null}
          <Toast.Description className="Toast-description" />
        </div>
        <Toast.Close aria-label="Close notification" className="Toast-close">
          Dismiss
        </Toast.Close>
      </Toast.Content>
    </Toast.Root>
  ));
}

export function AppToastProvider({ children }: { children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="Toast-viewport">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
