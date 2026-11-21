// @vitest-environment jsdom
/**
 * Leaving a page (lib/leave.ts): the bar's back control is the browser's
 * Back when a page of this app is behind the reader, and goes to the page
 * above only on a direct arrival. No link has to mark anything for that.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, useNavigate, type NavigateFunction } from "react-router-dom";
import { cameFromThisApp, historyIndex, useBackLabel, useLeave } from "./leave";
import { reportViewState } from "../analysis/TaskAnalysisFrame";

// React's act() needs this flag in a bare jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("leaving a page", () => {
  let container: HTMLDivElement;
  let root: Root;
  let navigate: NavigateFunction;
  let leave: (fallback: string) => void;
  let label = "";

  function Probe() {
    navigate = useNavigate();
    leave = useLeave();
    // The page's own title is its path, and the page above is "Task 3".
    label = useBackLabel(window.location.pathname, "Task 3");
    return null;
  }

  const path = () => window.location.pathname;
  const go = (to: string) => act(() => void navigate(to));
  /** jsdom traverses history in a task, so wait for the popstate. */
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

  beforeEach(() => {
    // A document loaded on this entry: react-router numbers it 0.
    window.history.replaceState(null, "", "/comp/c/analysis");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(BrowserRouter, null, createElement(Probe))));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("a direct arrival has nothing of ours behind it, and leaves for the page above", async () => {
    expect(historyIndex()).toBe(0);
    expect(cameFromThisApp()).toBe(false);
    expect(label).toBe("Back to Task 3");
    const length = window.history.length;
    act(() => leave("/comp/c/task/t"));
    await settle();
    expect(path()).toBe("/comp/c/task/t");
    // A replace: Back from the page above does not land on the page left.
    expect(window.history.length).toBe(length);
  });

  it("a page reached by an ordinary link goes back where the reader came from", async () => {
    // The case that went wrong: the comp analysis links to a task's analysis
    // with no marker of any kind, and the bar's back went to the task page.
    go("/comp/c/task/t/analysis");
    expect(cameFromThisApp()).toBe(true);
    act(() => leave("/comp/c/task/t"));
    await settle();
    expect(path()).toBe("/comp/c/analysis");
  });

  it("the back control is named for the page behind, where the reader came from one", async () => {
    go("/comp/c/task/t/analysis");
    await settle();
    expect(label).toBe("Back to /comp/c/analysis");
  });

  it("a second step back goes one page further, as the browser's Back does", async () => {
    go("/comp/c/task/t/analysis");
    go("/comp/c/task/t/analysis/thermals");
    act(() => leave("/comp/c/task/t/analysis"));
    await settle();
    expect(path()).toBe("/comp/c/task/t/analysis");
    act(() => leave("/comp/c/task/t"));
    await settle();
    expect(path()).toBe("/comp/c/analysis");
    // Back on the entry the document loaded on: nothing behind it again.
    expect(cameFromThisApp()).toBe(false);
  });
});

describe("reportViewState", () => {
  it("keeps the class and the pinned pilot, and nothing a section reads", () => {
    const q = new URLSearchParams("class=open&pilot=Ana&metric=climb&thermal=3&map=1");
    expect(reportViewState(q)).toBe("class=open&pilot=Ana");
    expect(reportViewState(new URLSearchParams("metric=climb"))).toBe("");
  });
});
