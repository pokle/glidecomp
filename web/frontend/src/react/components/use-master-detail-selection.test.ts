/**
 * The side-by-side seeding rule.
 *
 * Its whole job is to keep the list's lit row and the pane's subject the same
 * thing, and the case that matters is the one the code this replaces could not
 * handle: the query losing its selection AFTER a seed already ran. The thermal
 * census guarded with a ref that latched on the first seed, so a query wiped
 * afterwards — `useCanonicalPath` replaces the URL from a closure that can
 * predate the seed — left a wide reader with a pane showing a thermal and a
 * census with nothing lit, permanently. The behaviour ranking's copy re-seeded
 * and was fine. This is the ranking's rule, now the only one.
 */
import { describe, expect, it } from "vitest";
import { shouldSeedSelection } from "./use-master-detail-selection";

const wideAndEmpty = {
  enabled: true,
  wide: true,
  chosen: null,
  defaultId: "climb.rate",
};

describe("shouldSeedSelection", () => {
  it("seeds when the layout is side by side and the query names nothing", () => {
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
  });

  it("seeds AGAIN after a selection is undone — it does not latch", () => {
    // The sequence the latched version got wrong: seed, the query is wiped,
    // and the layout is still wide with a pane that has a subject.
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
    expect(
      shouldSeedSelection({ ...wideAndEmpty, chosen: "climb.rate" })
    ).toBe(false);
    expect(shouldSeedSelection(wideAndEmpty)).toBe(true);
  });

  it("never seeds while stacked — there the list IS the view, and a seeded query would open the detail", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, wide: false })).toBe(false);
  });

  it("leaves a selection the reader (or a shared link) already made", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, chosen: "glide.speed" })).toBe(
      false
    );
  });

  it("waits for the list to have something to select", () => {
    expect(shouldSeedSelection({ ...wideAndEmpty, enabled: false })).toBe(false);
    expect(shouldSeedSelection({ ...wideAndEmpty, defaultId: null })).toBe(false);
  });

  it("treats a numeric id 0 as a real default, not as absent", () => {
    // Thermal ids start at zero, which is why `chosen`/`defaultId` are
    // compared against null rather than tested for truthiness.
    expect(
      shouldSeedSelection({ ...wideAndEmpty, defaultId: 0, chosen: null })
    ).toBe(true);
    expect(
      shouldSeedSelection({ ...wideAndEmpty, defaultId: 0, chosen: 0 })
    ).toBe(false);
  });
});
