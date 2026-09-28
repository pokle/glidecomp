/**
 * Client entry for the GlideComp UI (React + react-aria-components SPA), served from
 * /app.html and mapped to /comp, /u/*, /scores, /settings, /onboarding and the
 * /admin routes. The public comp routes (the `ROUTES` array in
 * functions/comp/[[path]].ts is the list) are additionally server-rendered
 * there; when the server embedded its `__SSR_DATA__` JSON block
 * this entry hydrates that markup instead of creating a fresh root, seeding the
 * matching page from the same loader data so the first render matches.
 *
 * Home, about, legal and the scoring guides are static pages built by ./static
 * (Astro); the analysis and 3D replay pages remain separate vanilla entries.
 */
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./globals.css";
import { BrowserRouter } from "react-router-dom";
import { initTheme } from "./lib/theme";
import { installStaleDeployReload } from "./lib/stale-deploy";
import { AppToaster } from "./lib/toast";
import { maybeShowLegalNotice } from "./lib/legal-notice-toast";
import { getCurrentUserOnce } from "../auth/client";
import { InitialDataProvider, type InitialData } from "./lib/initial-data";
import { AppProviders, AppRoutes } from "./routes";
import { readSsrData } from "../ssr-data";

// A tab that outlived a deploy asks for chunks that no longer exist: reload it
// onto the new deploy, once (./lib/stale-deploy).
installStaleDeployReload();

// shadcn theming keys dark mode off a `.dark` class on <html>; apply the user's
// Light/Dark/Auto preference (Auto follows the OS). See ./lib/theme.
initTheme();

const initialData = readSsrData<InitialData>() ?? null;

// The app tree MUST match entry-server.tsx exactly for hydration. The toaster
// is intentionally NOT here: it renders a body-level portal and can't run on
// the server (no `document`), so having it as a child would make the client
// tree structurally differ from the server's. sonner's `toast()` is a global
// store, not React context, so the Toaster lives in its own root below.
const app = (
  <StrictMode>
    <AppProviders initialUser={initialData ? initialData.user : undefined}>
      <BrowserRouter>
        <InitialDataProvider value={initialData}>
          <AppRoutes />
        </InitialDataProvider>
      </BrowserRouter>
    </AppProviders>
  </StrictMode>
);

const root = document.getElementById("root")!;
if (initialData) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}

// Toaster in a detached root — out of the hydration tree, portals to <body>.
createRoot(document.createElement("div")).render(
  <StrictMode>
    <AppToaster />
  </StrictMode>
);

// The "terms changed" notice (./lib/legal-notice). The SSR payload already says
// who is signed in; otherwise ask the one shared /me flight rather than a
// second one. The delay lets the detached toaster above mount first — sonner
// drops a toast published before its Toaster subscribes.
const knownUser = initialData?.user;
void (knownUser !== undefined ? Promise.resolve(knownUser) : getCurrentUserOnce()).then((user) =>
  setTimeout(() => maybeShowLegalNotice(user), 1000)
);
