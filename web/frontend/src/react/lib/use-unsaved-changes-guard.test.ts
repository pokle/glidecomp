/**
 * What "Discard changes" does with the link that was stopped.
 *
 * The guard re-runs the navigation itself, and it used to send every
 * same-origin link through the router — so a link to a page the SERVER
 * answers (Home, About, the scoring guides) rendered the app's "page not
 * found" over a perfectly good address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { ConfirmContext, type ConfirmFn } from "./confirm";
import { useUnsavedChangesGuard } from "./use-unsaved-changes-guard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let routerPath: string;
let confirm: ReturnType<typeof vi.fn<ConfirmFn>>;
let onDiscard: ReturnType<typeof vi.fn<() => void>>;

function Page({ dirty }: { dirty: boolean }) {
  routerPath = useLocation().pathname;
  useUnsavedChangesGuard(dirty, {
    title: "Discard changes?",
    message: "They have not been saved.",
    onDiscard,
  });
  return createElement(
    "div",
    null,
    createElement("a", { href: "/comp", id: "app-link" }, "Competitions"),
    createElement("a", { href: "/about", id: "static-link" }, "About"),
    createElement("a", { href: "/", id: "home-link" }, "GlideComp"),
    createElement("a", { href: "/comp/x-abcd/scores.pdf", download: "", id: "download-link" }, "PDF")
  );
}

function mount(dirty: boolean) {
  act(() => {
    root.render(
      createElement(
        ConfirmContext.Provider,
        { value: confirm },
        createElement(
          MemoryRouter,
          { initialEntries: ["/settings"] },
          createElement(Page, { dirty })
        )
      )
    );
  });
}

/** Click a link the way a reader does, and let the guard's question settle. */
async function click(id: string): Promise<MouseEvent> {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    document.getElementById(id)!.dispatchEvent(event);
    await Promise.resolve();
    await Promise.resolve();
  });
  return event;
}

/** Whether the browser would still be asked to confirm leaving the page. */
function unloadIsGuarded(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  confirm = vi.fn<ConfirmFn>(() => Promise.resolve(true));
  onDiscard = vi.fn<() => void>();
  // jsdom does not navigate; it reports each attempt on the console instead.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("useUnsavedChangesGuard", () => {
  it("leaves links alone while nothing is unsaved", async () => {
    mount(false);
    const event = await click("static-link");
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("asks, and keeps the page when the reader keeps editing", async () => {
    confirm.mockResolvedValue(false);
    mount(true);
    const event = await click("app-link");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(routerPath).toBe("/settings");
    expect(unloadIsGuarded()).toBe(true);
  });

  it("sends a discarded link to a page of the app through the router", async () => {
    mount(true);
    await click("app-link");
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(routerPath).toBe("/comp");
  });

  it("does not hand the router a page the server answers", async () => {
    mount(true);
    for (const id of ["static-link", "home-link"]) {
      confirm.mockClear();
      await click(id);
      expect(confirm, id).toHaveBeenCalledTimes(1);
      // The router was not asked for a route it does not have …
      expect(routerPath, id).toBe("/settings");
    }
    expect(onDiscard).toHaveBeenCalled();
    // … and the browser is not left to ask "Leave site?" a second time.
    expect(unloadIsGuarded()).toBe(false);
  });

  it("does not ask about a download, which leaves nothing", async () => {
    mount(true);
    const event = await click("download-link");
    expect(confirm).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(routerPath).toBe("/settings");
  });
});
