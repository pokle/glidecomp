import { describe, expect, it } from "vitest";
import { isSpaRoute } from "./spa-routes";
import { STATIC_PAGE_ROUTES } from "./dev-routing";

describe("isSpaRoute", () => {
  it("is true for the app's own pages", () => {
    for (const path of ["/comp", "/comp/corryong-cup-vzuq/task/task-1-abcd", "/u/me", "/settings", "/submit", "/signin"]) {
      expect(isSpaRoute(path), path).toBe(true);
    }
  });

  it("is false for every prerendered content page", () => {
    for (const path of STATIC_PAGE_ROUTES) expect(isSpaRoute(path), path).toBe(false);
  });

  it("is false for a file and for the analysis page, which the server answers", () => {
    for (const path of ["/comp/corryong-cup-vzuq/scores.csv", "/comp/corryong-cup-vzuq/scores.pdf", "/analysis", "/analysis.html", "/civl-rankings.csv"]) {
      expect(isSpaRoute(path), path).toBe(false);
    }
  });
});
