/**
 * Which same-origin paths the React app shell (app.html) answers.
 *
 * In a module of its own, with no imports, because two different things ask:
 * the local servers that stand in for Cloudflare's routing (dev-routing.ts,
 * which re-exports it), and the app itself — the unsaved-changes guard has to
 * know whether a link it stopped stays inside the app or leaves for a page
 * the server answers (lib/use-unsaved-changes-guard.ts).
 */

/**
 * True for a path the React app shell (app.html) answers. Module and asset
 * requests contain a dot and never match.
 */
export function isSpaRoute(path: string): boolean {
  if (path.includes(".")) return false;
  return (
    path.startsWith("/u/") ||
    // All /comp* routes serve the shell, mirroring production where
    // _routes.json hands /comp* to the Pages Function (SSR with an SPA-shell
    // fallback). Covers every comp sub-route registered in
    // src/react/routes.tsx (waypoints, task, pilot, ...).
    path === "/comp" ||
    path.startsWith("/comp/") ||
    path === "/scores" ||
    // The kit form's test bench (e2e/forms.spec.ts). It exists only in a
    // development build and the e2e build (src/react/routes.tsx), and
    // production's _redirects does not name it.
    path === "/__kit/form" ||
    // The page-bar prototype (src/react/proto/ProtoApp.tsx): unlinked sample
    // pages, here until the recommendation it is for is settled (#860).
    path === "/proto" ||
    path.startsWith("/proto/") ||
    /^\/(submit|profile|settings|onboarding|signin|oauth\/consent)\/?$/.test(path) ||
    // Account settings: a page per group (/settings/profile), and the form
    // that makes an API key (/settings/api-keys/new).
    path.startsWith("/settings/") ||
    /^\/admin\/(users|cache)\/?$/.test(path)
  );
}
