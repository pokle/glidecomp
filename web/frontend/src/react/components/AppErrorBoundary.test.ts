/**
 * What a reader sees when a route throws: an apology with a way out, never a
 * blank page — and the error does not follow them to the next page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AppErrorBoundary } from "./AppErrorBoundary";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let navigate: ReturnType<typeof useNavigate> | null = null;

function Thrower({ message }: { message: string }): never {
  throw new TypeError(message);
}

function NavHandle() {
  navigate = useNavigate();
  return null;
}

function mount(message: string) {
  act(() => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/broken"] },
        createElement(NavHandle),
        createElement(
          AppErrorBoundary,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/broken",
              element: createElement(Thrower, { message }),
            }),
            createElement(Route, { path: "/fine", element: "Fine page" })
          )
        )
      )
    );
  });
}

beforeEach(() => {
  // React logs every caught render error; the test expects them.
  vi.spyOn(console, "error").mockImplementation(() => {});
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("AppErrorBoundary", () => {
  it("apologises and offers a reload and the home page", () => {
    mount("Cannot read properties of undefined");
    const heading = container.querySelector("h1");
    expect(heading?.textContent).toBe("Something went wrong");
    expect(document.activeElement).toBe(heading);
    expect(container.textContent).toContain("Reloading usually fixes it");
    const buttons = [...container.querySelectorAll("button, a")].map((b) => b.textContent);
    expect(buttons).toEqual(["Reload page", "Go to the home page"]);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/");
  });

  it("clears when the reader navigates elsewhere", () => {
    mount("Cannot read properties of undefined");
    act(() => navigate!("/fine"));
    expect(container.textContent).toBe("Fine page");
  });

  it("shows the screen for a missing chunk when a reload was already tried", () => {
    // The loop guard: a reload moments ago did not bring the chunk back.
    sessionStorage.setItem("glidecomp:stale-deploy-reload", String(Date.now()));
    mount("Failed to fetch dynamically imported module: /assets/Dashboard-a1b2.js");
    expect(container.querySelector("h1")?.textContent).toBe("Something went wrong");
  });
});
