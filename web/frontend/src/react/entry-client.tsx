/**
 * Client entry for the GlideComp UI (React + Base UI SPA), served from
 * /app.html and mapped to /comp, /u/*, /scores, /settings, /onboarding and the
 * /admin routes. The four public routes (/comp, /comp/:id, the task page and
 * the pilot score page) are additionally server-rendered by
 * functions/comp/[[path]].ts; when the server embedded `window.__SSR_DATA__`
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
import { AppToaster } from "./lib/toast";
import { InitialDataProvider, type InitialData } from "./lib/initial-data";
import { AppProviders, AppRoutes } from "./routes";

declare global {
  interface Window {
    __SSR_DATA__?: InitialData;
  }
}

// shadcn theming keys dark mode off a `.dark` class on <html>; follow the
// OS preference (matching the previous prefers-color-scheme behaviour).
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
function syncDarkClass() {
  document.documentElement.classList.toggle("dark", darkQuery.matches);
}
syncDarkClass();
darkQuery.addEventListener("change", syncDarkClass);

const initialData = window.__SSR_DATA__ ?? null;

// The app tree MUST match entry-server.tsx exactly for hydration. The toaster
// is intentionally NOT here: it renders a body-level portal and can't run on
// the server (no `document`), so having it as a child would make the client
// tree structurally differ from the server's. sonner's `toast()` is a global
// store, not React context, so the Toaster lives in its own root below.
const app = (
  <StrictMode>
    <AppProviders>
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
