/**
 * The loading primitives are almost all ARIA contract, and the contract is
 * exactly what an eyeball test can't see: an indeterminate bar is defined by
 * the ABSENCE of aria-valuenow, a decorative spinner by the absence of a
 * second accessible name, and a pending button by staying focusable while
 * refusing presses. Each of those has a plausible-looking wrong version that
 * renders identically, hence these tests.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProgressBar, Spinner, Loading } from "./progress";
import { Button } from "./button";

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

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ProgressBar", () => {
  it("omits aria-valuenow when indeterminate — that absence IS the state", () => {
    const el = render(
      createElement(ProgressBar, { isIndeterminate: true, "aria-label": "Re-scoring" })
    );
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("Re-scoring");
    // The travelling fill, whose reduced-motion fallback lives in globals.css.
    expect(el.querySelector(".gc-progress-indeterminate")).not.toBeNull();
  });

  it("reports the percentage when determinate, and draws no moving fill", () => {
    const el = render(
      createElement(ProgressBar, { value: 50, "aria-label": "Setup progress" })
    );
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(el.querySelector(".gc-progress-indeterminate")).toBeNull();
  });
});

describe("Spinner", () => {
  it("is a labelled progressbar when given a label", () => {
    const el = render(createElement(Spinner, { label: "Saving" }));
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("Saving");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  it("is pure decoration when unlabelled — no role for a screen reader to read", () => {
    const el = render(createElement(Spinner, {}));
    expect(el.querySelector('[role="progressbar"]')).toBeNull();
    expect(el.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Loading", () => {
  it("announces the sentence once, in a live region, with a silent spinner", () => {
    const el = render(createElement(Loading, { children: "Loading scores…" }));
    const status = el.querySelector('[role="status"]')!;
    expect(status.textContent).toBe("Loading scores…");
    // The spinner must not contribute a second reading of the same sentence.
    expect(status.querySelector('[role="progressbar"]')).toBeNull();
    expect(status.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    // The text IS the accessible content; an aria-label here would shadow it.
    expect(status.getAttribute("aria-label")).toBeNull();
  });
});

describe("Button isPending", () => {
  it("blocks presses but stays focusable, and keeps its visible label", () => {
    let presses = 0;
    const el = render(
      createElement(
        Button,
        { isPending: true, pendingLabel: "Saving", onPress: () => presses++ },
        "Save"
      )
    );
    const button = el.querySelector("button")!;
    // aria-disabled, NOT disabled: a disabled button loses focus mid-action.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("data-pending")).toBe("true");
    expect(button.textContent).toContain("Save");

    act(() => {
      button.click();
    });
    expect(presses).toBe(0);
  });

  it("carries the pending label as a progressbar RAC can fold into the name", () => {
    const el = render(
      createElement(Button, { isPending: true, pendingLabel: "Saving" }, "Save")
    );
    const bar = el.querySelector('button [role="progressbar"]')!;
    expect(bar).not.toBeNull();
    expect(bar.getAttribute("aria-label")).toBe("Saving");
  });

  it("adds nothing at rest — an idle button's name is just its label", () => {
    const el = render(createElement(Button, {}, "Save"));
    const button = el.querySelector("button")!;
    expect(button.querySelector('[role="progressbar"]')).toBeNull();
    expect(button.hasAttribute("data-pending")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(button.textContent).toBe("Save");
  });
});
