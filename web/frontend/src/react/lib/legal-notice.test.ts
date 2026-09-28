import { describe, test, expect } from "vitest";
import {
  LEGAL_NOTICE,
  formatLegalDate,
  legalNoticeEffectiveDate,
  shouldShowLegalNotice,
  type LegalNotice,
} from "./legal-notice";

const notice: LegalNotice = { version: "2026-09-28", message: "Updated." };

describe("shouldShowLegalNotice", () => {
  test("shows inside the 14-day window", () => {
    expect(shouldShowLegalNotice(notice, new Date("2026-09-28T00:00:00Z"), null)).toBe(true);
    expect(shouldShowLegalNotice(notice, new Date("2026-10-11T23:59:59Z"), null)).toBe(true);
  });

  test("never shows after the hard cutoff, dismissed or not", () => {
    expect(shouldShowLegalNotice(notice, new Date("2026-10-12T00:00:00Z"), null)).toBe(false);
    expect(shouldShowLegalNotice(notice, new Date("2027-01-01T00:00:00Z"), null)).toBe(false);
  });

  test("does not show before the version is published", () => {
    expect(shouldShowLegalNotice(notice, new Date("2026-09-27T23:59:59Z"), null)).toBe(false);
  });

  test("stays closed once dismissed for this version", () => {
    expect(shouldShowLegalNotice(notice, new Date("2026-10-01T00:00:00Z"), "2026-09-28")).toBe(false);
  });

  test("asks again when a newer version replaces a dismissed one", () => {
    const next = { ...notice, version: "2027-03-01" };
    expect(shouldShowLegalNotice(next, new Date("2027-03-02T00:00:00Z"), "2026-09-28")).toBe(true);
  });

  test("an unparseable version shows nothing rather than forever", () => {
    expect(shouldShowLegalNotice({ ...notice, version: "soon" }, new Date(), null)).toBe(false);
  });

  test("the shipped version is a real date", () => {
    expect(LEGAL_NOTICE.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(`${LEGAL_NOTICE.version}T00:00:00Z`))).toBe(false);
  });
});

describe("dates", () => {
  test("formats a date the same way everywhere", () => {
    expect(formatLegalDate("2026-10-13")).toBe("13 October 2026");
  });

  test("a change takes effect the notice period after publication", () => {
    expect(legalNoticeEffectiveDate(notice)).toBe("2026-10-12");
  });

  test("the toast names the effective date the page prints", () => {
    expect(LEGAL_NOTICE.message).toContain(
      formatLegalDate(legalNoticeEffectiveDate(LEGAL_NOTICE))
    );
  });
});
