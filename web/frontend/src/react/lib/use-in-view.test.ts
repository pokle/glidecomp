/**
 * The gate in front of the map bundles. Its whole job is "eventually true",
 * and the failure it must never have is "false forever" — a map panel that
 * says "Loading map…" for the rest of the page's life.
 *
 * The case that bit: both map pages render a loading state FIRST and only
 * render the ref'd map container once their data arrives. An effect that
 * reads `ref.current` once, on mount, sees null and never runs again — so the
 * observer is never attached to the element that eventually appears.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement, useState, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useInView } from "./use-in-view";

// React only runs effects synchronously inside act() when it knows it is under
// test; without this it warns and defers them, which this file depends on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The elements each live observer is watching, in creation order. */
let observed: Element[][];
let trigger: (el: Element) => void;

beforeEach(() => {
  observed = [];
  const targets = new Map<Element, FakeObserver>();

  class FakeObserver {
    readonly seen: Element[] = [];
    constructor(private readonly cb: IntersectionObserverCallback) {
      observed.push(this.seen);
    }
    observe(el: Element) {
      this.seen.push(el);
      targets.set(el, this);
    }
    unobserve(el: Element) {
      targets.delete(el);
    }
    disconnect() {
      for (const el of this.seen) targets.delete(el);
    }
    fire(el: Element) {
      this.cb(
        [{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      );
    }
  }

  trigger = (el: Element) => {
    const observer = targets.get(el);
    if (!observer) throw new Error("element is not being observed");
    act(() => observer.fire(el));
  };

  vi.stubGlobal("IntersectionObserver", FakeObserver);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

/**
 * A page shaped like the real ones: nothing but a "loading" line until
 * `ready`, then the panel the map lives in.
 */
function LatePanel({ ready }: { ready: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  if (!ready) return createElement("p", null, "Loading…");
  return createElement(
    "div",
    { ref, "data-testid": "panel" },
    inView ? "map" : "Loading map…"
  );
}

function Harness({ start }: { start: boolean }) {
  const [ready, setReady] = useState(start);
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => setReady(true) }, "load"),
    createElement(LatePanel, { ready })
  );
}

describe("useInView", () => {
  it("observes an element that mounts on the first render", () => {
    const el = render(createElement(LatePanel, { ready: true }));
    const panel = el.querySelector('[data-testid="panel"]')!;
    expect(panel.textContent).toBe("Loading map…");
    trigger(panel);
    expect(el.querySelector('[data-testid="panel"]')!.textContent).toBe("map");
  });

  it("observes an element that only mounts once the page's data arrives", () => {
    const el = render(createElement(Harness, { start: false }));
    expect(el.querySelector('[data-testid="panel"]')).toBeNull();

    act(() => {
      el.querySelector("button")!.click();
    });

    const panel = el.querySelector('[data-testid="panel"]')!;
    expect(panel.textContent).toBe("Loading map…");
    // Before the fix this threw: no observer was ever attached to the panel,
    // so it stayed "Loading map…" forever.
    trigger(panel);
    expect(el.querySelector('[data-testid="panel"]')!.textContent).toBe("map");
  });

  it("latches: a later scroll-away never tears the map back down", () => {
    const el = render(createElement(LatePanel, { ready: true }));
    const panel = el.querySelector('[data-testid="panel"]')!;
    trigger(panel);
    expect(el.querySelector('[data-testid="panel"]')!.textContent).toBe("map");
    // No observer is left watching once it has latched.
    expect(() => trigger(panel)).toThrow();
  });

  it("shows the content when the browser has no IntersectionObserver", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const el = render(createElement(LatePanel, { ready: true }));
    expect(el.querySelector('[data-testid="panel"]')!.textContent).toBe("map");
  });
});
