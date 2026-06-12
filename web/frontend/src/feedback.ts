/**
 * Shared user-feedback helpers: Basecoat toasts and modal confirm/alert
 * dialogs. Replaces native window.alert()/confirm() so all pages get the
 * same styled, accessible feedback as the analysis page.
 */
import "@pokle/basecoat/src/js/basecoat";
import "@pokle/basecoat/src/js/toast";

type ToastCategory = "success" | "error" | "info" | "warning";

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Basecoat's toast renderer interpolates config strings into innerHTML,
 * so everything passed to it must already be escaped. */
function ensureToaster(): void {
  if (document.getElementById("toaster")) return;
  const toaster = document.createElement("div");
  toaster.id = "toaster";
  toaster.className = "toaster";
  document.body.appendChild(toaster);
  if (document.readyState !== "loading") {
    (window as unknown as { basecoat?: { init: (name: string) => void } }).basecoat?.init("toaster");
  }
}

function showToast(category: ToastCategory, description: string, durationMs?: number): void {
  ensureToaster();
  document.dispatchEvent(
    new CustomEvent("basecoat:toast", {
      detail: {
        config: {
          category,
          description: escapeHtml(description),
          ...(durationMs !== undefined ? { duration: durationMs } : {}),
        },
      },
    })
  );
}

export const toast = {
  success: (message: string) => showToast("success", message),
  error: (message: string) => showToast("error", message),
  info: (message: string) => showToast("info", message),
  warning: (message: string) => showToast("warning", message),
};

interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Styled replacement for window.confirm(). Resolves true when the user
 * confirms, false when they cancel, click the backdrop, or press Escape.
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className =
      "fixed inset-0 m-auto h-fit rounded-lg border border-border bg-card p-0 shadow-lg backdrop:bg-black/50";
    const confirmClass = opts.destructive ? "btn-destructive" : "btn btn-primary";
    dialog.innerHTML = `
      <div class="w-96 max-w-[calc(100vw-2rem)] p-6">
        <h2 class="text-lg font-semibold mb-2">${escapeHtml(opts.title)}</h2>
        ${opts.message ? `<p class="text-sm text-muted-foreground">${escapeHtml(opts.message)}</p>` : ""}
        <div class="flex justify-end gap-2 mt-6">
          <button type="button" class="btn btn-secondary" data-cancel>${escapeHtml(opts.cancelLabel ?? "Cancel")}</button>
          <button type="button" class="${confirmClass}" data-confirm autofocus>${escapeHtml(opts.confirmLabel ?? "Confirm")}</button>
        </div>
      </div>`;

    let confirmed = false;
    dialog.querySelector("[data-cancel]")!.addEventListener("click", () => dialog.close());
    dialog.querySelector("[data-confirm]")!.addEventListener("click", () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(confirmed);
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/**
 * Styled replacement for window.alert() — a modal that stops the user until
 * acknowledged. Use toast.error() instead unless the user must not miss it
 * (e.g. storage quota exceeded).
 */
export function alertDialog(opts: { title: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className =
      "fixed inset-0 m-auto h-fit rounded-lg border border-border bg-card p-0 shadow-lg backdrop:bg-black/50";
    dialog.innerHTML = `
      <div class="w-96 max-w-[calc(100vw-2rem)] p-6">
        <h2 class="text-lg font-semibold mb-2">${escapeHtml(opts.title)}</h2>
        <p class="text-sm text-muted-foreground">${escapeHtml(opts.message)}</p>
        <div class="flex justify-end mt-6">
          <button type="button" class="btn btn-primary" data-ok autofocus>OK</button>
        </div>
      </div>`;

    dialog.querySelector("[data-ok]")!.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve();
    });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
