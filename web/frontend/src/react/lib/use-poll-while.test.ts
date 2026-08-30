/**
 * The poll behind "this page refreshes itself".
 *
 * Both task-analysis pages make that promise while a cold analysis computes
 * in the background, and each used to keep its own identical copy of the
 * effect. The three behaviours that matter are the ones a copy could quietly
 * lose: it backs off, it eventually stops, and it doesn't talk to the API from
 * a tab nobody is looking at.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePollWhile } from "./use-poll-while";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let hidden: boolean;

/** Mount the hook with a tick counter, and a handle to re-render it. */
function mount(active: boolean) {
  const ticks = { count: 0 };
  let restartKey = 0;
  function Probe({ on, k }: { on: boolean; k: number }) {
    usePollWhile(on, () => ticks.count++, k);
    return null;
  }
  act(() => {
    root.render(createElement(Probe, { on: active, k: restartKey }));
  });
  return {
    ticks,
    /** Re-render, optionally bumping the restart key as a landed refetch would. */
    update(on: boolean, bumpKey = false) {
      if (bumpKey) restartKey++;
      act(() => {
        root.render(createElement(Probe, { on, k: restartKey }));
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("usePollWhile", () => {
  it("does not poll when there is nothing pending", () => {
    const { ticks } = mount(false);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(ticks.count).toBe(0);
  });

  it("first asks after the initial delay, not immediately", () => {
    const { ticks } = mount(true);
    act(() => void vi.advanceTimersByTime(2_999));
    expect(ticks.count).toBe(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(ticks.count).toBe(1);
  });

  it("stops asking once the caller says it is no longer pending", () => {
    const probe = mount(true);
    act(() => void vi.advanceTimersByTime(3_000));
    expect(probe.ticks.count).toBe(1);

    probe.update(false);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(probe.ticks.count).toBe(1);
  });

  it("reschedules instead of fetching while the tab is hidden", () => {
    // A comp left open in a background tab must not keep the API busy.
    hidden = true;
    const { ticks } = mount(true);
    act(() => void vi.advanceTimersByTime(60_000));
    expect(ticks.count).toBe(0);

    hidden = false;
    act(() => void vi.advanceTimersByTime(10_000));
    expect(ticks.count).toBe(1);
  });

  it("gives up after about two minutes rather than polling for ever", () => {
    // The pending banner stays up; a manual reload picks up whatever is
    // newest. Each tick here stands in for a refetch that landed still-pending,
    // which is what keeps the schedule running.
    const probe = mount(true);
    for (let i = 0; i < 40; i++) {
      act(() => void vi.advanceTimersByTime(10_000));
      probe.update(true, true);
    }
    const settled = probe.ticks.count;

    act(() => void vi.advanceTimersByTime(600_000));
    expect(probe.ticks.count).toBe(settled);
    // It really did poll before giving up — otherwise this test proves nothing.
    expect(settled).toBeGreaterThan(0);
  });

  it("backs off rather than asking at a fixed rate", () => {
    // 3s, then ×1.5 to a 10s ceiling. Without the restart key bump a landed
    // response would leave the old timer running against stale state, so the
    // caller passes its refetch counter and each tick restarts the schedule.
    const probe = mount(true);

    act(() => void vi.advanceTimersByTime(3_000));
    expect(probe.ticks.count).toBe(1);

    // A tick means a refetch went out; the response landing bumps the key.
    probe.update(true, true);
    act(() => void vi.advanceTimersByTime(4_499));
    expect(probe.ticks.count).toBe(1); // 3s × 1.5 = 4.5s, not another 3s
    act(() => void vi.advanceTimersByTime(1));
    expect(probe.ticks.count).toBe(2);

    // And again: 4.5 × 1.5 = 6.75s.
    probe.update(true, true);
    act(() => void vi.advanceTimersByTime(6_749));
    expect(probe.ticks.count).toBe(2);
    act(() => void vi.advanceTimersByTime(1));
    expect(probe.ticks.count).toBe(3);
  });

  it("starts over once a fresh poll begins", () => {
    // The backoff and the deadline belong to one pending episode. A page that
    // goes ready and later pends again gets a full budget, not the tail of the
    // last one.
    const probe = mount(true);
    act(() => void vi.advanceTimersByTime(3_000));
    expect(probe.ticks.count).toBe(1);

    probe.update(false);
    probe.update(true);
    act(() => void vi.advanceTimersByTime(2_999));
    expect(probe.ticks.count).toBe(1);
    act(() => void vi.advanceTimersByTime(1));
    expect(probe.ticks.count).toBe(2); // back to the 3s opening delay
  });
});
