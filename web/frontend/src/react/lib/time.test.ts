import { describe, expect, test } from "vitest";
import {
  buildZoneCycle,
  formatInstant,
  formatTimeInZone,
  utcToZonedHHMM,
  zonedToUtcHHMM,
  zoneLabel,
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

describe("zoneLabel", () => {
  // Winter in the southern hemisphere (AEST, no DST), summer in the north.
  const winter = new Date("2026-07-07T14:32:00Z");
  // Southern summer (AEDT), northern winter (PST).
  const summer = new Date("2026-01-15T14:32:00Z");

  test("names + numeric offset when an abbreviation is available", () => {
    expect(zoneLabel(winter, MEL)).toBe("AEST (GMT+10)");
    expect(zoneLabel(summer, MEL)).toBe("AEDT (GMT+11)");
    expect(zoneLabel(winter, "America/Los_Angeles")).toBe("PDT (GMT-7)");
    expect(zoneLabel(summer, "America/Los_Angeles")).toBe("PST (GMT-8)");
    expect(zoneLabel(winter, "Europe/London")).toBe("BST (GMT+1)");
  });

  test("bare offset when the zone has no named abbreviation", () => {
    expect(zoneLabel(winter, "Asia/Kolkata")).toBe("GMT+5:30");
    expect(zoneLabel(winter, "Africa/Nairobi")).toBe("GMT+3");
  });

  test("renders a zero offset as UTC", () => {
    expect(zoneLabel(winter, "UTC")).toBe("UTC");
    expect(zoneLabel(winter, "Etc/UTC")).toBe("UTC");
  });
});

describe("formatInstant", () => {
  const d = new Date("2026-07-07T14:32:00Z");

  test("fixed en-GB 24h date/time plus the zone label", () => {
    expect(formatInstant(d, "UTC")).toBe("7 Jul 2026, 14:32 UTC");
    // 14:32 UTC = 00:32 the next day in AEST.
    expect(formatInstant(d, MEL)).toBe("8 Jul 2026, 00:32 AEST (GMT+10)");
  });
});

describe("buildZoneCycle", () => {
  const d = new Date("2026-07-07T14:32:00Z");

  test("empty for an invalid date", () => {
    expect(buildZoneCycle(new Date("nope"), MEL)).toEqual([]);
  });

  test("comp zone leads, is de-duplicated, and every rendering is unique", () => {
    const choices = buildZoneCycle(d, MEL);
    expect(choices[0].kind).toBe("comp");
    expect(choices[0].timeZone).toBe(MEL);
    expect(choices[0].text).toBe("8 Jul 2026, 00:32 AEST (GMT+10)");
    // UTC is always reachable, and no two choices render the same string
    // (true regardless of the machine's local zone).
    expect(choices.some((c) => c.text === "7 Jul 2026, 14:32 UTC")).toBe(true);
    expect(new Set(choices.map((c) => c.text)).size).toBe(choices.length);
  });

  test("an invalid comp zone is dropped, defaulting to the local zone", () => {
    const choices = buildZoneCycle(d, "Not/AZone");
    expect(choices.every((c) => c.kind !== "comp")).toBe(true);
    expect(choices[0].kind).toBe("local");
  });

  test("a comp zone that renders as UTC absorbs the separate UTC choice", () => {
    // Whatever the machine's local zone, the UTC candidate collapses into the
    // identical comp rendering, so no standalone "utc" choice remains.
    const choices = buildZoneCycle(d, "UTC");
    expect(choices[0].kind).toBe("comp");
    expect(choices[0].text).toBe("7 Jul 2026, 14:32 UTC");
    expect(choices.every((c) => c.kind !== "utc")).toBe(true);
  });
});
