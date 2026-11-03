/**
 * The side-by-side seeding rule.
 *
 * Its whole job is to keep the list's lit row and the pane's subject the same
 * thing, and the case that matters is the one the code this replaces could not
 * handle: the query losing its selection AFTER a seed already ran. The thermal
 * census guarded with a ref that latched on the first seed, so a query wiped
 * afterwards — `useCanonicalPath` replaces the URL from a closure that can
 * predate the seed — left a wide reader with a pane showing a thermal and a
 * census with nothing lit, permanently. The behaviour ranking's copy re-seeded
 * and was fine. This is the ranking's rule, now the only one.
 *
 * Re-seeding was still not enough (issue #845): a seed wiped before it ever
 * rendered changed none of the effect's inputs, so the effect never asked
 * again. The hook tests at the bottom drive that race for real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { shouldSeedSelection, useMasterDetailSelection } from "./use-master-detail-selection";
import { useCanonicalPath } from "../lib/use-canonical-path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wideAndEmpty = {
  enabled: true,
  wide: true,
  chosen: null,
  defaultId: "climb.rate",
};

describe("shouldSeedSelection", () => {
  it("seeds when the layout is side by side and the query names nothing", () => {
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
  });

  it("seeds AGAIN after a selection is undone — it does not latch", () => {
    // The sequence the latched version got wrong: seed, the query is wiped,
    // and the layout is still wide with a pane that has a subject.
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
    expect(
      shouldSeedSelection({ ...wideAndEmpty, chosen: "climb.rate" })
    ).toBe(false);
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
  });

  it("never seeds while stacked — there the list IS the view, and a seeded query would open the detail", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, wide: false })).toBe(false);
  });

  it("leaves a selection the reader (or a shared link) already made", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, chosen: "glide.speed" })).toBe(
      false
    );
  });

  it("waits for the list to have something to select", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, enabled: false })).toBe(false);
    expect(shouldSeedSelection({ ...wideAndEmpty, defaultId: null })).toBe(false);
  });

  it("treats a numeric id 0 as a real default, not as absent", () => {
    // Thermal ids start at zero, which is why `chosen`/`defaultId` are
    // compared against null rather than tested for truthiness.
    expect(
      shouldSeedSelection({ ...wideAndEmpty, defaultId: 0, chosen: null })
    ).toBe(true);
    expect(
      shouldSeedSelection({ ...wideAndEmpty, defaultId: 0, chosen: 0 })
    ).toBe(false);
  });

  it("does not write the default again when the URL already names it", () => {
    // `chosen` is null with the default in the URL only when the list does
    // not carry it. The seed runs on every location change, so writing it
    // again would replace the URL with itself, again and again.
    expect(shouldSeedSelection({ ...wideAndEmpty, named: "climb.rate" })).toBe(false);
    expect(shouldSeedSelection({ ...wideAndEmpty, defaultId: 0, named: "0" })).toBe(
      false
    );
  });

  it("replaces a parameter that names nothing in the list", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, named: "no.such.metric" })).toBe(true);
  });
});

describe("useMasterDetailSelection — the seed survives the page's own replace (#845)", () => {
  const BARE = "/comp/1/task/2/analysis/strategies";
  const CANONICAL = "/comp/corryong-cup-1/task/task-1-2/analysis/strategies";
  const METRICS = ["climb.rate", "glide.speed"];

  let container: HTMLDivElement;
  let root: Root;

  /**
   * The ranking: side by side from its first measure, with a list once the
   * report is `ready` — so the seed fires in the same commit as whatever the
   * page does when its names arrive.
   */
  function Ranking({ ready }: { ready: boolean }) {
    const [params] = useSearchParams();
    const named = params.get("metric");
    const chosen = named && METRICS.includes(named) ? named : null;
    const { onWideChange } = useMasterDetailSelection({
      param: "metric",
      chosen,
      defaultId: ready ? METRICS[0] : null,
      enabled: ready,
    });
    useEffect(() => onWideChange(true), [onWideChange]);
    return null;
  }

  /** A page whose own replace is built from the query its render saw — the
   *  way `useCanonicalPath` built it before #845, and the way any other
   *  replace from a stale closure still can. */
  function StalePage({ ready }: { ready: boolean }) {
    const location = useLocation();
    const navigate = useNavigate();
    useEffect(() => {
      if (!ready || location.pathname === CANONICAL) return;
      navigate(CANONICAL + location.search, { replace: true });
    }, [ready, location, navigate]);
    return createElement(Ranking, { ready });
  }

  /** The real page: `useCanonicalPath`, which now keeps the live query. */
  function CanonicalPage({ ready }: { ready: boolean }) {
    useCanonicalPath(ready ? CANONICAL : null);
    return createElement(Ranking, { ready });
  }

  function render(page: typeof StalePage, ready: boolean) {
    act(() => root.render(createElement(BrowserRouter, null, createElement(page, { ready }))));
  }

  const address = () => window.location.pathname + window.location.search;

  beforeEach(() => {
    window.history.replaceState(null, "", BARE);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("writes the default again when a replace from an older query wipes it", () => {
    render(StalePage, false);
    expect(address()).toBe(BARE);
    render(StalePage, true);
    expect(address()).toBe(`${CANONICAL}?metric=climb.rate`);
  });

  it("is in the canonical URL on a fresh load of a bare-id one", () => {
    render(CanonicalPage, false);
    render(CanonicalPage, true);
    expect(address()).toBe(`${CANONICAL}?metric=climb.rate`);
  });

  it("does not seed over a selection the URL already makes", () => {
    window.history.replaceState(null, "", `${BARE}?metric=glide.speed`);
    render(CanonicalPage, false);
    render(CanonicalPage, true);
    expect(address()).toBe(`${CANONICAL}?metric=glide.speed`);
  });
});
