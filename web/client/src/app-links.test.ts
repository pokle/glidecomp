import { describe, expect, it } from "bun:test";
import { androidAssetLinks, APPLE_LINK_COMPONENTS, appleAppSiteAssociation, appRouteForUrl } from "./app-links";

describe("appRouteForUrl", () => {
  it("opens a public page at the same path in the app", () => {
    expect(appRouteForUrl("https://glidecomp.com/comp/corryong-cup-2026-voqc")).toBe("/comp/corryong-cup-2026-voqc");
    expect(appRouteForUrl("https://glidecomp.com/comp/c-1/task/t-2/pilot/p-3")).toBe("/comp/c-1/task/t-2/pilot/p-3");
    expect(appRouteForUrl("https://www.glidecomp.com/comp/c-1/scores/")).toBe("/comp/c-1/scores");
    expect(appRouteForUrl("https://glidecomp.com/comp")).toBe("/comp");
  });

  it("keeps the analysis class, and moves the old and the differing shapes", () => {
    expect(appRouteForUrl("https://glidecomp.com/comp/c/task/t/analysis/weather?class=sport")).toBe("/comp/c/task/t/analysis/weather?class=sport");
    expect(appRouteForUrl("https://glidecomp.com/comp/c/analysis/task/t")).toBe("/comp/c/task/t/analysis");
    expect(appRouteForUrl("https://glidecomp.com/comp/c/task/t/pilot/p/manual-flight")).toBe("/comp/c/task/t/pilots/p/manual");
  });

  it("opens Submit with the comp and task it names", () => {
    expect(appRouteForUrl("https://glidecomp.com/submit?comp=c&task=t&junk=1")).toBe("/submit?comp=c&task=t");
    expect(appRouteForUrl("https://glidecomp.com/submit")).toBe("/submit");
  });

  it("takes the sign-in code from the fragment", () => {
    expect(appRouteForUrl("https://glidecomp.com/signin/app#otp=123456&email=a%40b.com")).toBe("/me/sign-in?otp=123456&email=a%40b.com");
    expect(appRouteForUrl("https://glidecomp.com/signin/app")).toBe("/me/sign-in");
  });

  it("leaves downloads, other hosts and other pages to the browser", () => {
    expect(appRouteForUrl("https://glidecomp.com/comp/c/scores.csv")).toBeNull();
    expect(appRouteForUrl("https://example.com/comp/c")).toBeNull();
    expect(appRouteForUrl("https://glidecomp.com/about")).toBeNull();
    expect(appRouteForUrl("https://glidecomp.com/signin")).toBeNull();
  });
});

describe("association files", () => {
  it("names both apps under the team, the download excluded first", () => {
    const doc = appleAppSiteAssociation("ABCDE12345") as { applinks: { details: { appIDs: string[]; components: unknown[] }[] } };
    expect(doc.applinks.details[0].appIDs).toEqual(["ABCDE12345.com.glidecomp.app", "ABCDE12345.com.glidecomp.app.dev"]);
    expect(APPLE_LINK_COMPONENTS[0]).toMatchObject({ "/": "/comp/*/scores.csv", exclude: true });
    expect(appleAppSiteAssociation(undefined)).toBeNull();
    expect(appleAppSiteAssociation("  ")).toBeNull();
  });

  it("lists every well-formed fingerprint, and nothing without one", () => {
    const fp = Array.from({ length: 32 }, () => "AB").join(":");
    const links = androidAssetLinks(`${fp.toLowerCase()}, not-a-fingerprint`) as { target: { package_name: string; sha256_cert_fingerprints: string[] } }[];
    expect(links.map((l) => l.target.package_name)).toEqual(["com.glidecomp.app", "com.glidecomp.app.dev"]);
    expect(links[0].target.sha256_cert_fingerprints).toEqual([fp]);
    expect(androidAssetLinks("nope")).toBeNull();
  });
});
