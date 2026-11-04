/**
 * The pilot-class refusals (src/pilot-classes.ts): one answer for the comp
 * create and update routes and the task routes, in an organiser's words, under
 * the field it is about.
 */
import { describe, expect, test } from "vitest";
import { classRefusal, taskClassRefusal } from "../src/pilot-classes";

describe("classRefusal", () => {
  test("settings that hang together are not refused", () => {
    expect(classRefusal(["open", "sport"], "sport", ["sport"])).toBeNull();
  });

  test("a default class the comp does not have names the default's field", () => {
    expect(classRefusal(["open", "sport"], "floater", [])).toEqual({
      error: `"floater" is not one of this competition's pilot classes (open, sport), so it cannot be the default pilot class.`,
      field: "default_pilot_class",
    });
  });

  test("a save that touches neither the default nor the classes does not check the default", () => {
    // null: the stored pair is what it is, and this save is not about it.
    expect(classRefusal(["open"], null, [])).toBeNull();
  });

  test("the default is answered first, as both routes always did", () => {
    expect(classRefusal(["open"], "floater", ["rigid"])?.field).toBe("default_pilot_class");
  });

  test("a Class 2 list naming classes the comp does not have lists every one", () => {
    expect(classRefusal(["open"], "open", ["floater", "rigid", "kingpost"])).toEqual({
      error: `"floater", "rigid" and "kingpost" are not among this competition's pilot classes (open), so they cannot fly FAI Class 2.`,
      field: "gap_params.hgClass2Classes",
    });
  });
});

describe("taskClassRefusal", () => {
  test("a task flown by some of the comp's classes is not refused", () => {
    expect(taskClassRefusal(["open", "sport"], ["sport"])).toBeNull();
  });

  test("one class the comp does not have", () => {
    expect(taskClassRefusal(["open", "sport"], ["open", "novice"])).toEqual({
      error: `"novice" is not one of this competition's pilot classes (open, sport).`,
      field: "pilot_classes",
    });
  });

  test("several", () => {
    expect(taskClassRefusal(["open"], ["novice", "floater"])?.error).toBe(
      `"novice" and "floater" are not among this competition's pilot classes (open).`
    );
  });
});
