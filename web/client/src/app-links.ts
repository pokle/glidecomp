/**
 * Universal links (mobile plan stage 9): which glidecomp.com URLs open the
 * app, the two association files that tell iOS and Android so, and where in
 * the app each URL lands.
 *
 * One module for all three, so the paths a phone hands to the app and the
 * paths the app knows how to open cannot drift apart. The app's routes are
 * the website's URLs (mobile/CLAUDE.md, "Layout"), so most map to themselves;
 * the few that differ are listed in `appRouteForUrl`.
 *
 * Only what a reader shares is claimed: the public competition pages, the
 * submit form, and the app's own sign-in link. `/signin` itself is NOT —
 * claiming it would pull the website's sign-in emails into the app on any
 * phone that has it installed — and neither is a file download
 * (`scores.csv`), which belongs in the browser.
 */

/** The bundle ids and packages that may open the links: the store app and the development build. */
export const APP_IDS = ["com.glidecomp.app", "com.glidecomp.app.dev"] as const;

/** The app's own sign-in link: the emailed code, for the app that asked for it. */
export const APP_SIGNIN_PATH = "/signin/app";

/** iOS `applinks` components, most specific first (the first match wins). */
export const APPLE_LINK_COMPONENTS: { "/": string; exclude?: true; comment: string }[] = [
  { "/": "/comp/*/scores.csv", exclude: true, comment: "A download, for the browser" },
  { "/": "/comp", comment: "The competitions list" },
  { "/": "/comp/*", comment: "Every public competition page" },
  { "/": "/submit", comment: "Submit a track" },
  { "/": APP_SIGNIN_PATH, comment: "The app's sign-in link" },
];

/** Android's equivalents: Android cannot exclude, so the app sends scores.csv back to the browser itself. */
export const ANDROID_LINK_PATHS: { path?: string; pathPrefix?: string }[] = [
  { path: "/comp" },
  { pathPrefix: "/comp/" },
  { path: "/submit" },
  { path: APP_SIGNIN_PATH },
];

/**
 * `/.well-known/apple-app-site-association`. Null without a Team ID: an
 * association naming no team would claim nothing, and a 404 says so more
 * honestly.
 */
export function appleAppSiteAssociation(teamId: string | undefined): object | null {
  const team = teamId?.trim();
  if (!team) return null;
  return {
    applinks: {
      details: [{ appIDs: APP_IDS.map((id) => `${team}.${id}`), components: APPLE_LINK_COMPONENTS }],
    },
  };
}

/**
 * `/.well-known/assetlinks.json`. Each signing certificate's SHA-256 (the
 * debug keystore's for a development build, Play's app-signing key for the
 * store), comma-separated. Null without any.
 */
export function androidAssetLinks(fingerprints: string | undefined): object[] | null {
  const prints = (fingerprints ?? "")
    .split(",")
    .map((f) => f.trim().toUpperCase())
    .filter((f) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(f));
  if (prints.length === 0) return null;
  return APP_IDS.map((pkg) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: pkg, sha256_cert_fingerprints: prints },
  }));
}

/**
 * Where in the app a glidecomp.com URL opens, or null when the app has no
 * screen for it and the browser should have it. Accepts a full URL or a
 * bare path (with its query and fragment).
 */
export function appRouteForUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url, "https://glidecomp.com");
  } catch {
    return null;
  }
  if (!/^(www\.)?glidecomp\.com$/i.test(parsed.hostname) && parsed.protocol.startsWith("http")) return null;
  const path = parsed.pathname.replace(/\/+$/, "") || "/";

  if (path === APP_SIGNIN_PATH) {
    // The code rides in the FRAGMENT, which never reaches a server log.
    const frag = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const otp = frag.get("otp");
    const email = frag.get("email");
    if (!otp || !email) return "/me/sign-in";
    return `/me/sign-in?${new URLSearchParams({ otp, email }).toString()}`;
  }

  if (path === "/submit") {
    const q = new URLSearchParams();
    for (const key of ["comp", "task"]) {
      const v = parsed.searchParams.get(key);
      if (v) q.set(key, v);
    }
    const s = q.toString();
    return s ? `/submit?${s}` : "/submit";
  }

  if (path === "/comp") return "/comp";
  if (!path.startsWith("/comp/")) return null;
  if (path.endsWith("/scores.csv")) return null;

  const parts = path.split("/").filter(Boolean); // ["comp", c, ...]
  // The comp analysis's old home for a task analysis (July–August 2026).
  if (parts[2] === "analysis" && parts[3] === "task" && parts[4]) {
    return `/comp/${parts[1]}/task/${parts[4]}/analysis${parts[5] ? `/${parts.slice(5).join("/")}` : ""}`;
  }
  // The website's manual-flight page is a child of the report card; the
  // app's sits with the organiser's Pilots & tracks.
  if (parts[2] === "task" && parts[4] === "pilot" && parts[6] === "manual-flight") {
    return `/comp/${parts[1]}/task/${parts[3]}/pilots/${parts[5]}/manual`;
  }
  const query = parsed.searchParams.get("class") ? `?class=${encodeURIComponent(parsed.searchParams.get("class")!)}` : "";
  return `${path}${query}`;
}
