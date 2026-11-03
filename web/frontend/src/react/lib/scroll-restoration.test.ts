/**
 * Back's scroll restore, against a page whose height and offset the test
 * drives — jsdom lays nothing out, so the window's scroll is a stand-in that
 * clamps the way a browser does.
 *
 * The two failures this file exists for:
 * - issue #844: a same-page REPLACE straight after Back (a list writing its
 *   default selection into the query, the canonical slug settling) cancelled
 *   the restore, and the reader landed at the top;
 * - issue #846: content loading late ABOVE the restored offset moved the
 *   reader off it, because the restore scrolled once and stopped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  BrowserRouter,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
} from "react-router-dom";
import {
  HOLD_MS,
  RESTORE_GRACE_MS,
  SETTLE_MS,
  restoreScroll,
  useScrollRestoration,
} from "./scroll-restoration";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT = 800;

/** The page: its height, and where the window is scrolled to. */
const page = { height: 0, y: 0 };

const maxScroll = () => Math.max(0, page.height - VIEWPORT);

/** The browser reporting a scroll, as it does a frame after the fact. */
function fireScroll() {
  window.dispatchEvent(new Event("scroll"));
}

/** Content grows or shrinks; the window clamps if it has to, and says so. */
function setHeight(height: number) {
  page.height = height;
  if (page.y > maxScroll()) {
    page.y = maxScroll();
    fireScroll();
  }
}

/** The reader (or anyone but the restore) moving the page. */
function scrollBySomeoneElse(y: number) {
  page.y = y;
  fireScroll();
}

/**
 * Animation frames on a clock the test owns. Hand-rolled rather than
 * vi.useFakeTimers: the hook tests need jsdom's real timers for Back's
 * popstate, and a restore started under one clock must not be ticked by
 * another.
 */
let clock = 0;
let nextFrame = 1;
const queued = new Map<number, FrameRequestCallback>();

/** Run animation frames for `ms` of page time. */
function frames(ms: number) {
  act(() => {
    const end = clock + ms;
    while (clock < end) {
      clock += 16;
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback(clock);
    }
  });
}

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clock = 0;
  queued.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    queued.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  page.height = 0;
  page.y = 0;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => page.y });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    get: () => page.height,
  });
  scrollTo = vi.fn((_x: number, y: number) => {
    page.y = Math.min(Math.max(0, y), maxScroll());
    fireScroll();
  });
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
  document.documentElement.style.overflowAnchor = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("restoreScroll", () => {
  it("waits for the document to be tall enough, then restores the offset", () => {
    page.height = 600; // "Loading…"
    const restore = restoreScroll(1500);
    frames(200);
    expect(scrollTo).not.toHaveBeenCalled();

    setHeight(3000);
    frames(32);
    expect(page.y).toBe(1500);
    expect(restore.active).toBe(true);
    restore.cancel();
  });

  it("gives up waiting after the grace period, and goes as far as the page does", () => {
    page.height = 1800;
    const restore = restoreScroll(1500);
    frames(RESTORE_GRACE_MS + 50);
    expect(page.y).toBe(1000);
    restore.cancel();
  });

  it("holds the offset while late content above it settles (#846)", () => {
    page.height = 3000;
    const restore = restoreScroll(1500);
    frames(16);
    expect(page.y).toBe(1500);

    // The section above swaps its "Loading…" line for what it loaded: on the
    // way the page is briefly shorter, and the window clamps…
    setHeight(2000);
    expect(page.y).toBe(1200);
    frames(48);
    expect(restore.active).toBe(true);
    // …and once it is tall again the reader is put back where they were.
    setHeight(3200);
    frames(32);
    expect(page.y).toBe(1500);
    restore.cancel();
  });

  it("turns the browser's scroll anchoring off while it holds, and back on after", () => {
    document.documentElement.style.overflowAnchor = "auto";
    page.height = 3000;
    const restore = restoreScroll(1500);
    frames(16);
    // Anchoring would keep the TRANSITIONAL page's content in view as the
    // late section grows above it — the view the reader never left.
    expect(document.documentElement.style.overflowAnchor).toBe("none");

    frames(HOLD_MS + SETTLE_MS + 100);
    expect(restore.active).toBe(false);
    expect(document.documentElement.style.overflowAnchor).toBe("auto");
  });

  it("keeps holding while the layout is still changing at the end of the hold", () => {
    page.height = 3000;
    const restore = restoreScroll(1500);
    frames(HOLD_MS - 100);
    setHeight(3100);
    frames(200);
    expect(restore.active).toBe(true);
    frames(SETTLE_MS + 100);
    expect(restore.active).toBe(false);
  });

  for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) {
    it(`never fights the reader: a ${type} ends it at once`, () => {
      page.height = 600;
      const restore = restoreScroll(1500);
      frames(32);
      window.dispatchEvent(new Event(type));
      expect(restore.active).toBe(false);
      expect(document.documentElement.style.overflowAnchor).toBe("");

      setHeight(3000);
      frames(200);
      expect(scrollTo).not.toHaveBeenCalled();
    });
  }

  it("ends when something else scrolls the page — a scrollbar drag, find in page", () => {
    page.height = 3000;
    const restore = restoreScroll(1500);
    frames(16);
    scrollBySomeoneElse(400);
    expect(restore.active).toBe(false);

    setHeight(3300);
    frames(200);
    expect(page.y).toBe(400);
  });

  it("does nothing more once cancelled", () => {
    page.height = 600;
    const restore = restoreScroll(1500);
    restore.cancel();
    setHeight(3000);
    frames(200);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(restore.active).toBe(false);
  });
});

describe("useScrollRestoration", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigate: NavigateFunction;

  function Probe() {
    useScrollRestoration();
    navigate = useNavigate();
    return null;
  }

  /** Back, and the popstate it fires (jsdom traverses history in a task). */
  async function back() {
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  function go(to: string, options?: NavigateOptions) {
    act(() => {
      void navigate(to, options);
    });
  }

  let entry = 0;
  beforeEach(() => {
    // A key of its own per test: offsets are kept per key for the life of
    // the module, and react-router would call every test's first entry
    // "default".
    window.history.replaceState(
      { usr: null, key: `entry-${++entry}`, idx: 0 },
      "",
      "/comp/1/task/2/analysis/strategies"
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(BrowserRouter, null, createElement(Probe))));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** Read somewhere down the page, then follow a link to another page. */
  function readThenLeave(y: number) {
    page.height = 3000;
    scrollBySomeoneElse(y);
    go("/comp/1/task/2/analysis/metrics/glide-speed");
    expect(page.y).toBe(0);
  }

  it("Back restores the offset the reader left at", async () => {
    readThenLeave(1200);
    await back();
    frames(32);
    expect(page.y).toBe(1200);
  });

  it("a same-page REPLACE straight after Back does not cancel the restore (#844)", async () => {
    readThenLeave(1200);
    // Back lands while the page is still loading, so the restore has to wait…
    page.height = 600;
    await back();
    frames(32);
    // …and before it can, the page writes its default selection into the
    // query, then settles its canonical slug: two REPLACEs of the same page.
    go("/comp/1/task/2/analysis/strategies?metric=glide.speed", { replace: true });
    go("/comp/c-1/task/t-2/analysis/strategies?metric=glide.speed", {
      replace: true,
      state: { preserveScroll: true },
    });
    setHeight(3000);
    frames(32);
    expect(page.y).toBe(1200);
  });

  it("a REPLACE onto a different page cancels the restore and starts at the top", async () => {
    readThenLeave(1200);
    page.height = 600;
    await back();
    go("/comp/1/settings", { replace: true });
    setHeight(3000);
    frames(200);
    expect(page.y).toBe(0);
  });

  it("an offset survives a same-page REPLACE the reader did not scroll after", async () => {
    // The thermals page: scroll, then flip the map on (a REPLACE writing
    // `?map=1`, so the entry has a new key) and leave without scrolling again.
    page.height = 3000;
    scrollBySomeoneElse(900);
    go("/comp/1/task/2/analysis/strategies?map=1", { replace: true });
    go("/comp/1/task/2/analysis/thermals/map");
    await back();
    frames(32);
    expect(page.y).toBe(900);
  });

  it("a PUSH starts at the top", () => {
    page.height = 3000;
    scrollBySomeoneElse(900);
    go("/comp/1/task/2");
    expect(page.y).toBe(0);
  });
});
