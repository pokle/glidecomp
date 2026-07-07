import { describe, expect, test } from "vitest";
import {
  formatComputedAt,
  formatTimeInZone,
  utcToZonedHHMM,
  zonedToUtcHHMM,
  zoneNameWithOffset,
} from "./time";

const MEL = "Australia/Melbourne";

describe("utcToZonedHHMM", () => {
  test("converts UTC gates to the comp wall clock (AEDT, +11)", () => {
    // Feb = southern summer → AEDT (UTC+11)
    expect(utcToZonedHHMM("2026-02-07", "01:30", MEL)).toBe("12:30");
  });

  test("uses the DST offset in force on the task date (AEST, +10)", () => {
    // July = southern winter → AEST (UTC+10)
    expect(utcToZonedHHMM("2026-07-07", "01:30", MEL)).toBe("11:30");
  });

  test("wraps across the date line without losing the time of day", () => {
    expect(utcToZonedHHMM("2026-02-07", "22:00", MEL)).toBe("09:00");
  });

  test("rejects malformed input and unknown zones", () => {
    expect(utcToZonedHHMM("2026-02-07", "25:99", MEL)).toBeNull();
    expect(utcToZonedHHMM("2026-02-07", "", MEL)).toBeNull();
    expect(utcToZonedHHMM("2026-02-07", "01:30", "Not/AZone")).toBeNull();
  });
});

describe("zonedToUtcHHMM", () => {
  test("is the inverse of utcToZonedHHMM", () => {
    expect(zonedToUtcHHMM("2026-02-07", "12:30", MEL)).toBe("01:30");
    expect(zonedToUtcHHMM("2026-07-07", "11:30", MEL)).toBe("01:30");
    // Morning gate in Melbourne is the previous UTC evening
    expect(zonedToUtcHHMM("2026-02-07", "09:00", MEL)).toBe("22:00");
  });

  test("round-trips every gate-plausible time on a DST-transition day", () => {
    // AEDT ends 2026-04-05 03:00 (clocks go back to 02:00 AEST). Hours
    // before the transition are inherently ambiguous when only a time of
    // day is stored (the xctsk format's own limitation) — flying gates
    // (04:00 onward) all round-trip exactly.
    for (let h = 4; h < 24; h++) {
      const wall = `${String(h).padStart(2, "0")}:15`;
      const utc = zonedToUtcHHMM("2026-04-05", wall, MEL);
      expect(utc).not.toBeNull();
      expect(utcToZonedHHMM("2026-04-05", utc!, MEL)).toBe(wall);
    }
  });

  test("rejects malformed input and unknown zones", () => {
    expect(zonedToUtcHHMM("2026-02-07", "9am", MEL)).toBeNull();
    expect(zonedToUtcHHMM("2026-02-07", "12:30", "Not/AZone")).toBeNull();
  });
});

describe("zoneNameWithOffset", () => {
  test("shows the zone name with the offset in force at the reference date", () => {
    expect(zoneNameWithOffset(new Date("2026-07-07T00:00:00Z"), MEL)).toBe(
      "Australia/Melbourne (GMT+10)"
    );
    expect(zoneNameWithOffset(new Date("2026-02-07T00:00:00Z"), MEL)).toBe(
      "Australia/Melbourne (GMT+11)"
    );
  });

  test("uses the viewer's zone when none is given", () => {
    const label = zoneNameWithOffset(new Date("2026-02-07T00:00:00Z"));
    expect(label).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(label).toMatch(/\(GMT[+-]?[\d:]*\)$/);
  });

  test("falls back to the bare name for unknown zones", () => {
    expect(zoneNameWithOffset(new Date(), "Not/AZone")).toBe("Not/AZone");
  });
});

describe("formatTimeInZone", () => {
  test("formats an instant in the given zone", () => {
    expect(formatTimeInZone(new Date("2026-02-07T01:30:05Z"), MEL)).toBe(
      "12:30:05"
    );
  });

  test("falls back to the viewer's zone for unknown zones", () => {
    expect(() =>
      formatTimeInZone(new Date("2026-02-07T01:30:05Z"), "Not/AZone")
    ).not.toThrow();
  });
});

describe("formatComputedAt", () => {
  const iso = "2026-07-07T14:32:00Z";

  test("renders an absolute time in the comp timezone with the zone name", () => {
    const out = formatComputedAt(iso, MEL);
    // 14:32 UTC = 00:32 the next day in AEST (UTC+10, no DST in July).
    expect(out).toContain("8 Jul 2026");
    expect(out).toContain("00:32");
    expect(out).toMatch(/GMT\+10|AEST/);
  });

  test("falls back to UTC when the comp has no timezone", () => {
    const out = formatComputedAt(iso, null);
    expect(out).toContain("7 Jul 2026");
    expect(out).toContain("14:32");
    expect(out).toMatch(/UTC|GMT(?!\+)/);
  });

  test("falls back to UTC on an unknown IANA zone instead of throwing", () => {
    const out = formatComputedAt(iso, "Not/AZone");
    expect(out).toContain("7 Jul 2026");
    expect(out).toContain("14:32");
  });
});
