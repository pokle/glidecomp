/**
 * The load every SSR'd comp page does, and the ways a hand-written copy of it
 * went wrong: forgetting to clear the previous verdict when the id in the path
 * changes, fetching over a seed the server already rendered, and passing off
 * the previous id's data as this one's.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSeededResource } from "./use-seeded-resource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Comp {
  name: string;
}

interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

type Load = (ids: string[]) => Promise<JsonResponse>;

let container: HTMLDivElement;
let root: Root;

function res(status: number, body?: Comp) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body as unknown,
  };
}

/** Render the hook and expose what it returned, plus a way to re-render. */
function mount(
  initialProps: { id: string | undefined; seed: Comp | null; refresh?: number },
  load: Load
) {
  const seen: { data: Comp | null; notFound: boolean; current: boolean }[] = [];
  function Probe({ id, seed, refresh }: { id: string | undefined; seed: Comp | null; refresh?: number }) {
    const r = useSeededResource<Comp>({
      ids: [id],
      seed,
      load,
      title: (c) => `GlideComp - ${c.name}`,
      refresh,
    });
    seen.push({ data: r.data, notFound: r.notFound, current: r.current });
    return null;
  }
  act(() => {
    root.render(createElement(Probe, initialProps));
  });
  return {
    seen,
    last: () => seen[seen.length - 1],
    update(props: { id: string | undefined; seed: Comp | null; refresh?: number }) {
      act(() => {
        root.render(createElement(Probe, props));
      });
    },
  };
}

/** Let the hook's async body settle. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  document.title = "";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useSeededResource", () => {
  it("renders the server's copy without asking for it again", async () => {
    const load = vi.fn<Load>();
    const probe = mount({ id: "abc", seed: { name: "Bright Open" } }, load);
    await settle();

    expect(probe.last().data).toEqual({ name: "Bright Open" });
    expect(load).not.toHaveBeenCalled();
    expect(document.title).toBe("GlideComp - Bright Open");
  });

  it("fetches when there is no seed, and names the tab from what arrives", async () => {
    const load = vi.fn<Load>().mockResolvedValue(res(200, { name: "Corryong" }));
    const probe = mount({ id: "abc", seed: null }, load);
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(probe.last().data).toEqual({ name: "Corryong" });
    expect(probe.last().notFound).toBe(false);
    expect(document.title).toBe("GlideComp - Corryong");
  });

  it("passes the resolved ids to the loader", async () => {
    const load = vi.fn<Load>().mockResolvedValue(res(200, { name: "X" }));
    mount({ id: "abc", seed: null }, load);
    await settle();
    expect(load).toHaveBeenCalledWith(["abc"]);
  });

  it("answers a missing id without spending a request", async () => {
    const load = vi.fn<Load>();
    const probe = mount({ id: undefined, seed: null }, load);
    await settle();

    expect(probe.last().notFound).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("reports a 404 as a dead URL", async () => {
    const load = vi.fn<Load>().mockResolvedValue(res(404));
    const probe = mount({ id: "gone", seed: null }, load);
    await settle();

    expect(probe.last().notFound).toBe(true);
    expect(probe.last().data).toBeNull();
    // A 404 is a real answer — fetchWithRetry must not have asked three times.
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("clears a stale not-found when the id in the path changes", async () => {
    // react-router keeps the page mounted when only the id changes, and the
    // 404 page's "did you mean" links point back at these very routes — so a
    // verdict left over from the old id would mask what the new one loads.
    const load = vi
      .fn<Load>()
      .mockResolvedValueOnce(res(404))
      .mockResolvedValueOnce(res(200, { name: "The Real One" }));

    const probe = mount({ id: "dead", seed: null }, load);
    await settle();
    expect(probe.last().notFound).toBe(true);

    probe.update({ id: "alive", seed: null });
    await settle();
    expect(probe.last().notFound).toBe(false);
    expect(probe.last().data).toEqual({ name: "The Real One" });
  });

  it("fetches past the seed once a mutation bumps refresh", async () => {
    const load = vi.fn<Load>().mockResolvedValue(res(200, { name: "Renamed" }));
    const seed = { name: "Original" };

    const probe = mount({ id: "abc", seed, refresh: 0 }, load);
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(probe.last().data).toEqual(seed);

    probe.update({ id: "abc", seed, refresh: 1 });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(probe.last().data).toEqual({ name: "Renamed" });
  });

  it("calls the server's copy current: it was rendered for this URL", async () => {
    const probe = mount({ id: "abc", seed: { name: "Bright Open" } }, vi.fn<Load>());
    expect(probe.last().current).toBe(true);
  });

  it("is not current until something has loaded", async () => {
    let answer!: (r: JsonResponse) => void;
    const load = vi.fn<Load>(() => new Promise((resolve) => (answer = resolve)));
    const probe = mount({ id: "abc", seed: null }, load);
    expect(probe.last().current).toBe(false);

    answer(res(200, { name: "Corryong" }));
    await settle();
    expect(probe.last().current).toBe(true);
  });

  it("keeps the previous id's data on screen, but never calls it current", async () => {
    // Reset link: the page moves onto the comp's new share key while it still
    // holds the comp loaded under the old one. A canonical path built from that
    // comp is the dead link — so nothing may treat it as this URL's until the
    // load for the new id lands.
    let answer!: (r: JsonResponse) => void;
    const load = vi
      .fn<Load>()
      .mockResolvedValueOnce(res(200, { name: "Old key" }))
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));

    const probe = mount({ id: "vzuq_oldkey", seed: null }, load);
    await settle();
    expect(probe.last()).toEqual({ data: { name: "Old key" }, notFound: false, current: true });

    const rendersBefore = probe.seen.length;
    probe.update({ id: "vzuq_newkey", seed: null });
    await settle();
    // Still showing what it had — no flash of a spinner — but not as current,
    // on any render since the id changed: one is enough to rewrite the URL.
    expect(probe.last()).toEqual({ data: { name: "Old key" }, notFound: false, current: false });
    expect(probe.seen.slice(rendersBefore).map((r) => r.current)).not.toContain(true);

    answer(res(200, { name: "New key" }));
    await settle();
    expect(probe.last()).toEqual({ data: { name: "New key" }, notFound: false, current: true });
  });

  it("is not current for an id it could not load", async () => {
    const load = vi
      .fn<Load>()
      .mockResolvedValueOnce(res(200, { name: "Alive" }))
      .mockResolvedValueOnce(res(404));
    const probe = mount({ id: "alive", seed: null }, load);
    await settle();

    probe.update({ id: "dead", seed: null });
    await settle();
    expect(probe.last().notFound).toBe(true);
    expect(probe.last().current).toBe(false);
  });

  it("stays current while a mutation refetches the same id", async () => {
    // A save bumps `refresh`; the URL has not moved, so the page's address bar
    // has nothing to wait for.
    let answer!: (r: JsonResponse) => void;
    const load = vi
      .fn<Load>()
      .mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const seed = { name: "Original" };
    const probe = mount({ id: "abc", seed, refresh: 0 }, load);

    probe.update({ id: "abc", seed, refresh: 1 });
    await settle();
    expect(probe.last().current).toBe(true);

    answer(res(200, { name: "Renamed" }));
    await settle();
    expect(probe.last()).toEqual({ data: { name: "Renamed" }, notFound: false, current: true });
  });

  it("treats a dropped request as a page that is not there, not as empty data", async () => {
    // Rendering an empty page would look like a real, empty competition.
    const load = vi.fn<Load>().mockRejectedValue(new TypeError("Failed to fetch"));
    const probe = mount({ id: "abc", seed: null }, load);
    await act(async () => {
      // fetchWithRetry spends its attempts before giving up.
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3), { timeout: 5_000 });
    });
    await settle();

    expect(probe.last().notFound).toBe(true);
    expect(probe.last().data).toBeNull();
  });
});
