/**
 * The load every SSR'd comp page does, and the two ways a hand-written copy
 * of it went wrong: forgetting to clear the previous verdict when the id in
 * the path changes, and fetching over a seed the server already rendered.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSeededResource } from "./use-seeded-resource";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Comp {
  name: string;
}

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
function mount(initialProps: { id: string | undefined; seed: Comp | null; refresh?: number }, load: ReturnType<typeof vi.fn>) {
  const seen: { data: Comp | null; notFound: boolean }[] = [];
  function Probe({ id, seed, refresh }: { id: string | undefined; seed: Comp | null; refresh?: number }) {
    const r = useSeededResource<Comp>({
      ids: [id],
      seed,
      load,
      title: (c) => `GlideComp - ${c.name}`,
      refresh,
    });
    seen.push({ data: r.data, notFound: r.notFound });
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
    const load = vi.fn();
    const probe = mount({ id: "abc", seed: { name: "Bright Open" } }, load);
    await settle();

    expect(probe.last().data).toEqual({ name: "Bright Open" });
    expect(load).not.toHaveBeenCalled();
    expect(document.title).toBe("GlideComp - Bright Open");
  });

  it("fetches when there is no seed, and names the tab from what arrives", async () => {
    const load = vi.fn().mockResolvedValue(res(200, { name: "Corryong" }));
    const probe = mount({ id: "abc", seed: null }, load);
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(probe.last().data).toEqual({ name: "Corryong" });
    expect(probe.last().notFound).toBe(false);
    expect(document.title).toBe("GlideComp - Corryong");
  });

  it("passes the resolved ids to the loader", async () => {
    const load = vi.fn().mockResolvedValue(res(200, { name: "X" }));
    mount({ id: "abc", seed: null }, load);
    await settle();
    expect(load).toHaveBeenCalledWith(["abc"]);
  });

  it("answers a missing id without spending a request", async () => {
    const load = vi.fn();
    const probe = mount({ id: undefined, seed: null }, load);
    await settle();

    expect(probe.last().notFound).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("reports a 404 as a dead URL", async () => {
    const load = vi.fn().mockResolvedValue(res(404));
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
      .fn()
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
    const load = vi.fn().mockResolvedValue(res(200, { name: "Renamed" }));
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

  it("treats a dropped request as a page that is not there, not as empty data", async () => {
    // Rendering an empty page would look like a real, empty competition.
    const load = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
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
