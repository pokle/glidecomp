import { describe, expect, it } from "vitest";
import type { WaypointFileRecord } from "@glidecomp/engine";
import {
  activeToken,
  completeToken,
  inferTypes,
  matchWaypoints,
  parseQuickTask,
  parseRadiusToken,
  quickTaskText,
  randomExampleRoute,
  suggestionsFor,
  resolveTypes,
  tokenizeQuickTask,
} from "./quick-task";

function wp(code: string, name = code): WaypointFileRecord {
  return { code, name, latitude: -36.5, longitude: 147.8, altitude: 0, radius: 400 };
}

const WAYPOINTS = [
  wp("ELLIOT", "Mount Elliot"),
  wp("ELLIOTP", "Elliot Paddock"),
  wp("MITTA", "Mitta Mitta"),
  wp("CUDGWA", "Cudgewa"),
  wp("NCORRY", "North Corryong"),
  wp("BOGONG", "Mount Bogong"),
];

describe("parseRadiusToken", () => {
  it("reads metres, km and bare numbers", () => {
    expect(parseRadiusToken("400m")).toBe(400);
    expect(parseRadiusToken("400")).toBe(400);
    expect(parseRadiusToken("5k")).toBe(5000);
    expect(parseRadiusToken("5km")).toBe(5000);
    expect(parseRadiusToken("2.5km")).toBe(2500);
  });

  it("rejects names and zero", () => {
    expect(parseRadiusToken("ell")).toBeNull();
    expect(parseRadiusToken("A01")).toBeNull();
    expect(parseRadiusToken("0")).toBeNull();
  });
});

describe("tokenizeQuickTask", () => {
  it("splits on spaces and commas only", () => {
    expect(tokenizeQuickTask("ell 400m, mitta,cudg  ncor").map((t) => t.raw)).toEqual([
      "ell",
      "400m",
      "mitta",
      "cudg",
      "ncor",
    ]);
  });

  it("keeps punctuation a waypoint code might contain", () => {
    // Real codes: "Mt_Buffalo_-_Lookout", "Gutt_Ridge_No.1", "13th_Beach/W".
    expect(tokenizeQuickTask("Break_o_Day_Road_-_A 400m").map((t) => t.raw)).toEqual([
      "Break_o_Day_Road_-_A",
      "400m",
    ]);
    expect(tokenizeQuickTask("Gutt_Ridge_No.1").map((t) => t.raw)).toEqual([
      "Gutt_Ridge_No.1",
    ]);
  });

  it("leaves the dot alone — it's a decimal point, not a separator", () => {
    expect(tokenizeQuickTask("ell 2.5km mitta").map((t) => t.raw)).toEqual([
      "ell",
      "2.5km",
      "mitta",
    ]);
    expect(parseRadiusToken(tokenizeQuickTask("2.5k")[0].raw)).toBe(2500);
  });

  it("splits on whitespace and commas, keeping offsets", () => {
    const tokens = tokenizeQuickTask("ell 400m, mitta");
    expect(tokens.map((t) => [t.raw, t.kind])).toEqual([
      ["ell", "name"],
      ["400m", "radius"],
      ["mitta", "name"],
    ]);
    expect(tokens[2].start).toBe(10);
  });
});

describe("matchWaypoints", () => {
  it("ranks the shorter code first on a prefix match", () => {
    expect(matchWaypoints("ell", WAYPOINTS).map((w) => w.code)).toEqual([
      "ELLIOT",
      "ELLIOTP",
    ]);
  });

  it("matches on the long name too", () => {
    expect(matchWaypoints("cudge", WAYPOINTS)[0].code).toBe("CUDGWA");
    expect(matchWaypoints("bogong", WAYPOINTS)[0].code).toBe("BOGONG");
  });

  it("prefers an exact code over a longer prefix match", () => {
    expect(matchWaypoints("elliot", WAYPOINTS)[0].code).toBe("ELLIOT");
  });

  it("returns nothing for a name no waypoint could be", () => {
    expect(matchWaypoints("zzzz", WAYPOINTS)).toEqual([]);
  });

  // The real Corryong Cup waypoint file — codes drop letters, so a setter
  // typing the place name has to land on them by similarity alone.
  const CORRYONG = [
    "ELLIOT", "KANGCK", "MTMITA", "TINTAL", "TOWONG", "CORRY", "WALWA",
    "CUDGWE", "ELLITP", "TOOMA", "PINEMT", "HALFWY", "THOWGL", "CUDGNO",
    "CUDG", "PINEFO", "CLCCLC",
  ].map((c) => wp(c));

  it("matches abbreviated real codes typed as spoken", () => {
    expect(matchWaypoints("mitta", CORRYONG)[0].code).toBe("MTMITA");
    // "cudgewa" is genuinely ambiguous between CUDG and CUDGWE — both are
    // offered, and the chip menu is how you take the other one.
    expect(matchWaypoints("cudgewa", CORRYONG).map((w) => w.code)).toContain(
      "CUDGWE"
    );
    expect(matchWaypoints("towong", CORRYONG)[0].code).toBe("TOWONG");
    expect(matchWaypoints("ell", CORRYONG).map((w) => w.code)).toEqual([
      "ELLIOT",
      "ELLITP",
    ]);
  });
});

describe("parseQuickTask", () => {
  const opts = { defaultRadius: 400 };

  it("parses the whole line, attaching radii to the name before them", () => {
    const items = parseQuickTask(
      "ell 400m ell 5k mitta cudg ncor 1k",
      WAYPOINTS,
      opts
    );
    expect(
      items.map((i) => [i.candidates[0]?.code, i.radius, i.radiusExplicit])
    ).toEqual([
      ["ELLIOT", 400, true],
      ["ELLIOT", 5000, true],
      ["MITTA", 400, false],
      ["CUDGWA", 400, false],
      ["NCORRY", 1000, true],
    ]);
  });

  it("treats a leading distance as the default for the rest of the line", () => {
    const items = parseQuickTask("2k ell mitta 400m", WAYPOINTS, opts);
    expect(items.map((i) => i.radius)).toEqual([2000, 400]);
  });

  it("takes a type word as the type of the turnpoint before it", () => {
    const items = parseQuickTask("ell 500 to, ell 5k sss", WAYPOINTS, opts);
    expect(
      items.map((i) => [i.candidates[0]?.code, i.radius, i.explicitType])
    ).toEqual([
      ["ELLIOT", 500, "TAKEOFF"],
      ["ELLIOT", 5000, "SSS"],
    ]);
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "SSS"]);
  });

  it("infers the types the text leaves out", () => {
    const items = parseQuickTask("ell mitta cudgwa bogong ncorry", WAYPOINTS, opts);
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "SSS", "", "ESS", ""]);
  });

  it("lets an explicit type override the inferred one", () => {
    // "tp" says plain turnpoint — MITTA would otherwise be the inferred SSS.
    const items = parseQuickTask("ell mitta tp cudgwa bogong", WAYPOINTS, opts);
    expect(items).toHaveLength(4);
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "", "ESS", ""]);
  });

  it("moves a role rather than doubling it when the text places it late", () => {
    const items = parseQuickTask("ell mitta cudgwa sss bogong ncorry", WAYPOINTS, opts);
    // SSS is claimed at CUDGWA, so inference doesn't also put one at MITTA.
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "", "SSS", "ESS", ""]);
  });

  it("prefers a waypoint over a type word when a code collides", () => {
    const withGoal = [...WAYPOINTS, wp("GOAL", "Goal Paddock")];
    const items = parseQuickTask("ell goal", withGoal, opts);
    expect(items).toHaveLength(2);
    expect(items[1].candidates[0].code).toBe("GOAL");
  });

  it("keeps unmatched names as items with no candidates", () => {
    const items = parseQuickTask("ell zzzz", WAYPOINTS, opts);
    expect(items).toHaveLength(2);
    expect(items[1].candidates).toEqual([]);
    expect(items[1].query).toBe("zzzz");
  });
});

describe("resolveTypes — one of each role", () => {
  const opts = { defaultRadius: 400 };
  const typesOf = (line: string) =>
    resolveTypes(parseQuickTask(line, WAYPOINTS, opts));

  it("keeps the first of repeated starts and ESSes", () => {
    // The reported line: two sss and two ess, all of them honoured.
    expect(
      typesOf("elliot to ell sss cudgwa sss mitta ess ncorry ess bogong goal")
    ).toEqual(["TAKEOFF", "SSS", "", "ESS", "", ""]);
  });

  it("drops a take-off that isn't the first turnpoint", () => {
    expect(typesOf("ell mitta to cudgwa bogong")).toEqual([
      "TAKEOFF",
      "SSS",
      "ESS",
      "",
    ]);
  });

  it("drops a goal that isn't the last turnpoint", () => {
    expect(typesOf("ell mitta goal cudgwa bogong")).toEqual([
      "TAKEOFF",
      "SSS",
      "ESS",
      "",
    ]);
  });

  it("accepts both ends spelled out — the common habit", () => {
    expect(typesOf("ell to mitta cudgwa bogong goal")).toEqual([
      "TAKEOFF",
      "SSS",
      "ESS",
      "",
    ]);
  });
});

describe("activeToken", () => {
  it("is the name token under the caret", () => {
    expect(activeToken("ell mit")?.raw).toBe("mit");
    expect(activeToken("ell mit", 3)?.raw).toBe("ell");
  });

  it("is nothing after a space, or on a radius", () => {
    expect(activeToken("ell ")).toBeNull();
    expect(activeToken("ell 400m")).toBeNull();
  });
});

describe("completeToken", () => {
  it("replaces the token in place and leaves one trailing space", () => {
    const text = "ell 400m mit";
    const token = activeToken(text)!;
    expect(completeToken(text, token, "MITTA")).toEqual({
      text: "ell 400m MITTA ",
      caret: 15,
    });
  });

  it("keeps the rest of the line when completing mid-text", () => {
    const text = "ell mit cudgwa";
    const token = activeToken(text, 7)!;
    expect(completeToken(text, token, "MITTA").text).toBe("ell MITTA cudgwa");
  });

  it("replaces the separator that followed the fragment", () => {
    const text = "ell, mit, cudgwa";
    const token = activeToken(text, 8)!;
    expect(completeToken(text, token, "MITTA").text).toBe("ell, MITTA cudgwa");
  });
});

describe("inferTypes", () => {
  it("types a full race: takeoff, start, …, ESS, goal", () => {
    expect(inferTypes(5)).toEqual(["TAKEOFF", "SSS", "", "ESS", ""]);
  });

  it("always makes the first the take-off and the last the goal", () => {
    expect(inferTypes(1)).toEqual(["TAKEOFF"]);
    expect(inferTypes(2)).toEqual(["TAKEOFF", ""]);
  });

  it("starts the speed section at the middle of a three-turnpoint task", () => {
    expect(inferTypes(3)).toEqual(["TAKEOFF", "SSS", ""]);
  });
});

describe("quickTaskText", () => {
  const route = (...tps: [string, number, string][]) =>
    tps.map(([name, radius, type]) => ({ name, radius, type: type as "" }));

  it("spells out every radius and stays silent about inferred types", () => {
    expect(
      quickTaskText(
        route(
          ["ELLIOT", 400, "TAKEOFF"],
          ["MITTA", 1000, "SSS"],
          ["CUDGWA", 2500, ""],
          ["BOGONG", 400, "ESS"],
          ["NCORRY", 400, ""]
        )
      )
    ).toBe("ELLIOT 400m, MITTA 1k, CUDGWA 2.5k, BOGONG 400m, NCORRY 400m");
  });

  it("names the types position wouldn't infer", () => {
    expect(quickTaskText(route(["ELLIOT", 500, "TAKEOFF"], ["ELLIOT", 5000, "SSS"]))).toBe(
      "ELLIOT 500m, ELLIOT 5k sss"
    );
  });

  it("names every role when asked, and still round-trips", () => {
    const spelled = quickTaskText(
      route(
        ["ELLIOT", 400, "TAKEOFF"],
        ["MITTA", 400, "SSS"],
        ["CUDGWA", 400, ""],
        ["BOGONG", 400, "ESS"],
        ["NCORRY", 400, ""]
      ),
      { types: "all" }
    );
    expect(spelled).toBe(
      "ELLIOT 400m to, MITTA 400m sss, CUDGWA 400m, BOGONG 400m ess, NCORRY 400m goal"
    );
    const items = parseQuickTask(spelled, WAYPOINTS, { defaultRadius: 400 });
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "SSS", "", "ESS", ""]);
  });

  it("keeps the tp markers a role-less route needs", () => {
    const spelled = quickTaskText(
      route(
        ["ELLIOT", 400, "TAKEOFF"],
        ["MITTA", 400, ""],
        ["CUDGWA", 400, ""],
        ["BOGONG", 400, ""],
        ["NCORRY", 400, ""]
      ),
      { types: "all" }
    );
    expect(spelled).toBe(
      "ELLIOT 400m to, MITTA 400m tp, CUDGWA 400m, BOGONG 400m tp, NCORRY 400m goal"
    );
    const items = parseQuickTask(spelled, WAYPOINTS, { defaultRadius: 400 });
    expect(resolveTypes(items)).toEqual(["TAKEOFF", "", "", "", ""]);
  });

  it("round-trips through the parser", () => {
    const text = quickTaskText(
      route(
        ["ELLIOT", 500, "TAKEOFF"],
        ["ELLIOT", 5000, "SSS"],
        ["MITTA", 1000, ""],
        ["CUDGWA", 400, "ESS"],
        ["BOGONG", 400, ""]
      )
    );
    const items = parseQuickTask(text, WAYPOINTS, { defaultRadius: 400 });
    expect(
      items.map((i, n) => [i.candidates[0].code, i.radius, resolveTypes(items)[n]])
    ).toEqual([
      ["ELLIOT", 500, "TAKEOFF"],
      ["ELLIOT", 5000, "SSS"],
      ["MITTA", 1000, ""],
      ["CUDGWA", 400, "ESS"],
      ["BOGONG", 400, ""],
    ]);
    expect(quickTaskText(
      items.map((i, n) => ({
        name: i.candidates[0].code,
        radius: i.radius,
        type: resolveTypes(items)[n],
      }))
    )).toBe(text);
  });
});

describe("suggestionsFor", () => {
  it("offers nothing once the token spells a code exactly", () => {
    expect(suggestionsFor("MITTA", WAYPOINTS)).toEqual([]);
    expect(suggestionsFor("mitta", WAYPOINTS)).toEqual([]);
    // Even when a longer code shares the prefix — the choice is made.
    expect(suggestionsFor("ELLIOT", WAYPOINTS)).toEqual([]);
  });

  it("offers the alternatives right up to the exact spelling", () => {
    expect(suggestionsFor("ELLIO", WAYPOINTS).map((w) => w.code)).toEqual([
      "ELLIOT",
      "ELLIOTP",
    ]);
  });

  it("is unchanged for a partial token", () => {
    expect(suggestionsFor("mit", WAYPOINTS)[0].code).toBe("MITTA");
  });
});

describe("commas", () => {
  it("are optional — the parser treats them as whitespace", () => {
    const opts = { defaultRadius: 400 };
    const withCommas = parseQuickTask("ell 500 to, ell 5k sss, mitta", WAYPOINTS, opts);
    const without = parseQuickTask("ell 500 to ell 5k sss mitta", WAYPOINTS, opts);
    const shape = (items: ReturnType<typeof parseQuickTask>) =>
      items.map((i, n) => [i.candidates[0]?.code, i.radius, resolveTypes(items)[n]]);
    expect(shape(without)).toEqual(shape(withCommas));
    expect(shape(without)).toEqual([
      ["ELLIOT", 500, "TAKEOFF"],
      ["ELLIOT", 5000, "SSS"],
      ["MITTA", 400, ""],
    ]);
  });
});

describe("randomExampleRoute", () => {
  // A fixed sequence stands in for Math.random, so the shape is testable.
  const seeded = (values: number[]) => {
    let i = 0;
    return () => values[i++ % values.length];
  };

  it("writes a route the parser reads back", () => {
    const text = randomExampleRoute(WAYPOINTS, {
      defaultRadius: 400,
      rng: seeded([0.1, 0.3, 0.5, 0.7, 0.2, 0.9, 0.4]),
    });
    const items = parseQuickTask(text, WAYPOINTS, { defaultRadius: 400 });
    expect(items.length).toBeGreaterThanOrEqual(4);
    // Every name in the example is one of this comp's waypoints.
    for (const item of items) expect(item.candidates[0]).toBeDefined();
    // And it round-trips: taking the example builds exactly what it reads.
    const types = resolveTypes(items);
    expect(
      quickTaskText(
        items.map((i, n) => ({
          name: i.candidates[0].code,
          radius: i.radius,
          type: types[n],
        }))
      )
    ).toBe(text);
  });

  it("never repeats a waypoint", () => {
    const text = randomExampleRoute(WAYPOINTS, {
      defaultRadius: 400,
      rng: seeded([0.5]),
    });
    const codes = parseQuickTask(text, WAYPOINTS, { defaultRadius: 400 }).map(
      (i) => i.candidates[0].code
    );
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("takes a size — open distance allows exactly one turnpoint", () => {
    const text = randomExampleRoute(WAYPOINTS, {
      defaultRadius: 400,
      size: 1,
      rng: seeded([0.2]),
    });
    expect(parseQuickTask(text, WAYPOINTS, { defaultRadius: 400 })).toHaveLength(1);
  });

  it("is empty when the competition has no waypoints", () => {
    expect(randomExampleRoute([], { defaultRadius: 400 })).toBe("");
  });
});
