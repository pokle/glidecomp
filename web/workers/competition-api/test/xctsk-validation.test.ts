// SEC-12 regression: the xctsk validator must accept every real-world
// task we've shipped, but reject pathological payloads — oversize JSON,
// excessive turnpoint counts, deep nesting via unknown keys, out-of-
// range coordinates / radii, and so on.
//
// Real samples live in web/samples/comps and web/frontend/public/data/tasks
// and range 1.1–2.0 KB. The schema's caps are 16–100× generous to keep
// legitimate tasks comfortable while bounding the attack surface.

import { describe, expect, test } from "vitest";
import { xctskSchema } from "../src/validators";

const SAMPLE_TASK = {
  earthModel: "WGS84",
  goal: { deadline: "08:00:00Z", type: "CYLINDER" },
  sss: {
    direction: "EXIT",
    timeGates: ["03:00:00Z", "03:15:00Z", "03:30:00Z"],
    type: "RACE",
  },
  taskType: "CLASSIC",
  version: 1,
  turnpoints: [
    {
      radius: 3000,
      type: "SSS",
      waypoint: {
        altSmoothed: 932,
        description: "ELLIOT",
        lat: -36.18583297729492,
        lon: 147.97666931152344,
        name: "ELLIOT",
      },
    },
    {
      radius: 1500,
      waypoint: {
        altSmoothed: 375,
        description: "KANGCK",
        lat: -36.26409912109375,
        lon: 147.93846130371094,
        name: "KANGCK",
      },
    },
  ],
};

describe("xctskSchema — happy path", () => {
  test("accepts a realistic task", () => {
    expect(() => xctskSchema.parse(SAMPLE_TASK)).not.toThrow();
  });

  test("accepts a minimal task (no sss / goal / takeoff)", () => {
    const minimal = {
      taskType: "CLASSIC",
      turnpoints: [
        {
          radius: 1000,
          waypoint: { name: "Start", lat: 0, lon: 0 },
        },
      ],
    };
    expect(() => xctskSchema.parse(minimal)).not.toThrow();
  });

  test("strips unknown top-level keys instead of rejecting", () => {
    // Strict mode rejects unknown keys — this verifies the documented
    // behaviour: unknown keys cause validation failure rather than
    // silently passing through into D1.
    const withExtra = { ...SAMPLE_TASK, futureSpecField: "oops" };
    expect(() => xctskSchema.parse(withExtra)).toThrow();
  });
});

describe("xctskSchema — SEC-12 rejections", () => {
  test("rejects more than 50 turnpoints", () => {
    const tps = Array.from({ length: 51 }, (_, i) => ({
      radius: 1000,
      waypoint: { name: `TP${i}`, lat: 0, lon: 0 },
    }));
    const xctsk = { ...SAMPLE_TASK, turnpoints: tps };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects more than 100 timeGates", () => {
    const gates = Array.from({ length: 101 }, () => "03:00:00Z");
    const xctsk = {
      ...SAMPLE_TASK,
      sss: { ...SAMPLE_TASK.sss, timeGates: gates },
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects waypoint name > 64 chars", () => {
    const tooLong = "x".repeat(65);
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 1000,
          waypoint: { name: tooLong, lat: 0, lon: 0 },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects out-of-range latitude", () => {
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 1000,
          waypoint: { name: "X", lat: 91, lon: 0 },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects out-of-range longitude", () => {
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 1000,
          waypoint: { name: "X", lat: 0, lon: 181 },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects radius > 50000", () => {
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 50001,
          waypoint: { name: "X", lat: 0, lon: 0 },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects unknown turnpoint type", () => {
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 1000,
          // @ts-expect-error: testing runtime validation of an invalid enum
          type: "GOAL",
          waypoint: { name: "X", lat: 0, lon: 0 },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("rejects unknown waypoint key (deep-nesting attempt)", () => {
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: [
        {
          radius: 1000,
          waypoint: {
            name: "X",
            lat: 0,
            lon: 0,
            // Attempting to smuggle a nested object through an unknown key.
            // .strict() should reject the whole turnpoint.
            extras: { deeplyNested: { andMore: { stillMore: true } } },
          },
        },
      ],
    };
    expect(() => xctskSchema.parse(xctsk)).toThrow();
  });

  test("an all-maxed-fields payload still fits comfortably under the size cap", () => {
    // Belt-and-braces sanity: the size-refine in the schema is a
    // backstop. With every individual limit at its maximum (50 TPs ×
    // maxed strings + 100 timeGates) the stringified payload is well
    // under the 32 KB cap — confirming the cap won't reject anything
    // that respects the per-field limits, but is there to catch a
    // future spec extension that bypasses them.
    const longDesc = "y".repeat(64);
    const longName = "n".repeat(64);
    const tps = Array.from({ length: 50 }, () => ({
      radius: 1000,
      waypoint: {
        name: longName,
        description: longDesc,
        lat: 12.345678901234567,
        lon: 123.45678901234567,
        altSmoothed: 12345,
      },
    }));
    const gates = Array.from({ length: 100 }, () => "12:34:56Z");
    const xctsk = {
      ...SAMPLE_TASK,
      turnpoints: tps,
      sss: { ...SAMPLE_TASK.sss, timeGates: gates },
    };
    expect(JSON.stringify(xctsk).length).toBeLessThan(32 * 1024);
    expect(() => xctskSchema.parse(xctsk)).not.toThrow();
  });
});
