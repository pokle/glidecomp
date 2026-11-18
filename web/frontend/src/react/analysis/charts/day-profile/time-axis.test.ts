import { describe, expect, it } from "vitest";
import { buildTimeAxis, tickLabelStride } from "./time-axis";

const T = (iso: string) => new Date(iso).getTime();

describe("buildTimeAxis", () => {
  it("returns null with no finite instants", () => {
    expect(buildTimeAxis([], "UTC", [0, 100])).toBeNull();
    expect(buildTimeAxis([NaN], "UTC", [0, 100])).toBeNull();
  });

  it("ticks on whole UTC hours for a UTC axis", () => {
    const axis = buildTimeAxis(
      [T("2026-01-10T02:10:00Z"), T("2026-01-10T05:40:00Z")],
      "UTC",
      [0, 560]
    )!;
    expect(axis.ticks.map((t) => t.label)).toEqual(["03:00", "04:00", "05:00"]);
    // Ticks land on exact hour instants.
    for (const t of axis.ticks) expect(t.ms % 3_600_000).toBe(0);
  });

  it("ticks on the wall-clock hour in a half-hour-offset zone", () => {
    // Adelaide is UTC+10:30 in January (ACDT). Wall hours are at :30 UTC.
    const axis = buildTimeAxis(
      [T("2026-01-10T02:10:00Z"), T("2026-01-10T04:50:00Z")],
      "Australia/Adelaide",
      [0, 560]
    )!;
    expect(axis.ticks.length).toBeGreaterThan(0);
    for (const t of axis.ticks) {
      expect(t.label.endsWith(":00")).toBe(true); // whole wall hours…
      expect(new Date(t.ms).getUTCMinutes()).toBe(30); // …at :30 UTC
    }
  });

  it("scales the domain onto the pixel range monotonically", () => {
    const a = T("2026-01-10T02:00:00Z");
    const b = T("2026-01-10T06:00:00Z");
    const axis = buildTimeAxis([a, b], "UTC", [40, 540])!;
    expect(axis.x(axis.domainStart)).toBeCloseTo(40);
    expect(axis.x(axis.domainEnd)).toBeCloseTo(540);
    expect(axis.x(a)).toBeLessThan(axis.x(b));
  });

  it("widens a degenerate span and still produces a tick", () => {
    const t = T("2026-01-10T03:00:00Z");
    const axis = buildTimeAxis([t, t], "UTC", [0, 560])!;
    expect(axis.domainEnd - axis.domainStart).toBeGreaterThanOrEqual(30 * 60_000);
    expect(axis.ticks.length).toBeGreaterThan(0);
  });

  it("uses 30-minute steps for a short day and 2-hour steps for a long one", () => {
    const short = buildTimeAxis(
      [T("2026-01-10T02:00:00Z"), T("2026-01-10T03:30:00Z")],
      "UTC",
      [0, 560]
    )!;
    expect(short.ticks.some((t) => t.label.endsWith(":30"))).toBe(true);

    const long = buildTimeAxis(
      [T("2026-01-10T00:00:00Z"), T("2026-01-10T12:00:00Z")],
      "UTC",
      [0, 560]
    )!;
    const hours = long.ticks.map((t) => new Date(t.ms).getUTCHours());
    for (let i = 1; i < hours.length; i++) expect(hours[i] - hours[i - 1]).toBe(2);
  });

  it("falls back to UTC ticks for an unknown zone", () => {
    const axis = buildTimeAxis(
      [T("2026-01-10T02:10:00Z"), T("2026-01-10T05:40:00Z")],
      "Not/AZone",
      [0, 560]
    )!;
    for (const t of axis.ticks) expect(t.ms % 3_600_000).toBe(0);
  });
});

describe("tickLabelStride", () => {
  const T = (iso: string) => new Date(iso).getTime();
  const span: number[] = [T("2026-01-05T02:00:00Z"), T("2026-01-05T09:00:00Z")];

  it("labels every tick when the labels have room", () => {
    const axis = buildTimeAxis(span, "Australia/Melbourne", [44, 540])!;
    expect(tickLabelStride(axis, 40)).toBe(1);
  });

  it("labels every second tick when neighbours would touch", () => {
    // A phone: about 260px of plot for eight hourly ticks.
    const axis = buildTimeAxis(span, "Australia/Melbourne", [46, 301])!;
    expect(tickLabelStride(axis, 43)).toBe(2);
  });

  it("is 1 for an axis with a single tick", () => {
    const axis = buildTimeAxis(span, "Australia/Melbourne", [0, 100])!;
    expect(tickLabelStride({ ...axis, ticks: axis.ticks.slice(0, 1) }, 500)).toBe(1);
  });
});
