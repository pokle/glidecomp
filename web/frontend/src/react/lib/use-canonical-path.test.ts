/**
 * The canonical replace, and the query it carries (issue #845).
 *
 * It used to rebuild the address from the `location` its render saw. A child
 * writing a parameter in the same commit — the task analysis seeding its
 * default `?metric=` / `?thermal=` — wrote first (a child's effects run before
 * its parent's), and the replace then put the older, emptier query back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useLocation, useSearchParams } from "react-router-dom";
import { liveQueryAndHash, useCanonicalPath } from "./use-canonical-path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BARE = "/comp/1/task/2/analysis/strategies";
const CANONICAL = "/comp/corryong-cup-1/task/task-1-2/analysis/strategies";

let container: HTMLDivElement;
let root: Root;
let lastState: unknown;

/**
 * Writes `?metric=` once it is ready — the list seeding its default, and only
 * once, so the test sees what the canonical replace does to that one write.
 */
function Seeder({ ready }: { ready: boolean }) {
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (!ready) return;
    const next = new URLSearchParams(params);
    next.set("metric", "glide.speed");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  return null;
}

/** The page: canonicalises once its names have "loaded". */
function Page({ ready }: { ready: boolean }) {
  useCanonicalPath(ready ? CANONICAL : null);
  lastState = useLocation().state;
  return createElement(Seeder, { ready });
}

function render(ready: boolean) {
  act(() => root.render(createElement(BrowserRouter, null, createElement(Page, { ready }))));
}

/** A page with nothing else writing to the URL. */
function Plain() {
  useCanonicalPath(CANONICAL);
  lastState = useLocation().state;
  return null;
}

function renderPlain() {
  act(() => root.render(createElement(BrowserRouter, null, createElement(Plain))));
}

const address = () => window.location.pathname + window.location.search + window.location.hash;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  lastState = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useCanonicalPath", () => {
  it("settles a bare-id URL on the canonical one, keeping its query and hash", () => {
    window.history.replaceState(null, "", `${BARE}?class=open#ranking`);
    renderPlain();
    expect(address()).toBe(`${CANONICAL}?class=open#ranking`);
    // Same page, corrected address: scroll restoration leaves the reader be.
    expect(lastState).toMatchObject({ preserveScroll: true });
  });

  it("keeps a parameter written in the same commit (#845)", () => {
    window.history.replaceState(null, "", BARE);
    render(false);
    expect(address()).toBe(BARE);

    // The names and the list arrive together: the seed and the canonical
    // replace run in ONE commit, the seed first.
    render(true);
    expect(address()).toBe(`${CANONICAL}?metric=glide.speed`);
  });

  it("leaves an address that is already canonical alone", () => {
    window.history.replaceState(null, "", `${CANONICAL}?metric=climb.rate`);
    const length = window.history.length;
    renderPlain();
    expect(address()).toBe(`${CANONICAL}?metric=climb.rate`);
    expect(window.history.length).toBe(length);
  });
});

describe("liveQueryAndHash", () => {
  it("reads the address bar while it is on the rendered page", () => {
    window.history.replaceState({ idx: 0 }, "", `${BARE}?metric=glide.speed#x`);
    expect(liveQueryAndHash({ pathname: BARE, search: "", hash: "" })).toBe(
      "?metric=glide.speed#x"
    );
  });

  it("answers nothing once the address bar has gone to another page", () => {
    window.history.replaceState({ idx: 3 }, "", "/comp/1/settings");
    expect(liveQueryAndHash({ pathname: BARE, search: "?a=1", hash: "" })).toBeNull();
  });

  it("falls back to the rendered location when the window is not the router's", () => {
    // A MemoryRouter's location has nothing to do with the window's address,
    // and react-router never stamped the window's history with an `idx`.
    window.history.replaceState(null, "", "/");
    expect(liveQueryAndHash({ pathname: BARE, search: "?a=1", hash: "#b" })).toBe("?a=1#b");
  });
});
