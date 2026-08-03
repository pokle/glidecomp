/**
 * `nameAffinity` orders the "which registration are you?" picker, and does
 * nothing else. The negatives below matter more than the positives: this
 * function must never grow into something that could LINK two records, and a
 * test that only proves it says yes a lot is how that happens.
 */
import { describe, expect, test } from "vitest";
import { nameAffinity, orderByLikelihood } from "../src/pilot-linker";

describe("names that are the same name", () => {
  test.each([
    ["Jane Smith", "Jane Smith", "identical"],
    ["JANE SMITH", "jane smith", "case"],
    ["Smith, Jane", "Jane Smith", "the comma form a spreadsheet exports"],
    ["Jane  Smith ", " jane smith", "stray whitespace"],
    ["Müller", "Muller", "accents an import dropped"],
    ["Jean-Luc Picard", "Jean Luc Picard", "a hyphen one side only"],
    ["Smith Jane", "Jane Smith", "given/family order swapped"],
  ])("%s ≈ %s (%s)", (a, b) => {
    expect(nameAffinity(a, b)).toBe(2);
  });

  test("an initial for a first name is a weaker yes, not a no", () => {
    expect(nameAffinity("J Smith", "Jane Smith")).toBe(1);
    expect(nameAffinity("Jane Smith", "J Smith")).toBe(1);
  });
});

describe("names that are NOT the same name", () => {
  test.each([
    ["Jane Smith", "John Smith", "different given name"],
    ["Jane Smith", "Jane Smithers", "a longer surname is a different surname"],
    ["Jane Smith", "Smith", "a surname alone identifies nobody"],
    ["Jane Smith", "Jane", "nor does a given name alone"],
    ["Jane Smith", "Bob Jones", "unrelated"],
    ["J Smith", "John Smith", "SAME initial, different person — still only 1"],
  ])("%s ≠ %s (%s)", (a, b, why) => {
    // The last row is the interesting one: "J Smith" could be Jane or John,
    // which is exactly why this function may never decide anything by itself.
    expect(nameAffinity(a, b)).toBeLessThan(2);
    if (!why.includes("still only 1")) expect(nameAffinity(a, b)).toBe(0);
  });

  test("an empty name matches nothing, including another empty name", () => {
    expect(nameAffinity("", "Jane Smith")).toBe(0);
    expect(nameAffinity("   ", "")).toBe(0);
    expect(nameAffinity("!!!", "Jane Smith")).toBe(0);
  });
});

describe("ordering the picker", () => {
  const roster = [
    { registered_pilot_name: "Zoe Adams" },
    { registered_pilot_name: "Bob Jones" },
    { registered_pilot_name: "SMITH, Jane" },
    { registered_pilot_name: "J Smith" },
  ];

  test("puts the pilot's likely self first, then alphabetical", () => {
    const ordered = orderByLikelihood(roster, "Jane Smith").map(
      (r) => r.registered_pilot_name
    );
    expect(ordered).toEqual(["SMITH, Jane", "J Smith", "Bob Jones", "Zoe Adams"]);
  });

  test("keeps everyone — it orders, it does not filter", () => {
    // The rule for WHETHER to ask is "is there an unclaimed row", never a name
    // threshold. If this ever filtered, a pilot registered as "Mick" would
    // never see "Michael" and would silently get a duplicate.
    expect(orderByLikelihood(roster, "Nobody At All")).toHaveLength(4);
  });

  test("does not mutate the array it was given", () => {
    const original = [...roster];
    orderByLikelihood(roster, "Jane Smith");
    expect(roster).toEqual(original);
  });
});
