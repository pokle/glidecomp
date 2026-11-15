/**
 * The page-bar prototype (/proto) — NOT part of the app.
 *
 * A set of sample pages for trying one navigation bar on every kind of page
 * the app has, before any real page changes (issue #860). It is reached only
 * by typing its address: nothing links here, robots are told not to index it
 * (below, and `X-Robots-Tag` in public/_headers), and it is one lazy chunk, so
 * nobody else downloads it. Sample data only; it calls no API.
 *
 * It stands outside the app's Shell on purpose: the bar is a candidate to
 * replace the Shell's header on these pages, so it cannot sit under it.
 *
 * Delete the `proto/` folder, its route in routes.tsx, its rows in
 * public/_redirects and public/_headers, and its line in src/spa-routes.ts
 * when the recommendation is settled.
 */
import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { RacRouterProvider } from "@/react/rac/router";
import { useRouteFocus } from "../lib/route-focus";
import { useScrollRestoration } from "../lib/scroll-restoration";
import { CompHub, CompSettings, CompSettingsForm, ReportCard, Scores, Task } from "./CompPages";
import { OptionsProvider } from "./options";
import { CopyPilots, EditPilot, NewPilot, Pilots } from "./PilotPages";
import { Missing, ProtoIndex } from "./ProtoIndex";
import { RoutePage, TurnpointPage } from "./RoutePages";
import { Competitions, MyFlights, NewComp, SubmitTrack } from "./TopLevelPages";

export function ProtoApp() {
  useScrollRestoration();
  useRouteFocus();
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    const title = document.title;
    document.title = "Page bar prototype - GlideComp";
    return () => {
      meta.remove();
      document.title = title;
    };
  }, []);

  return (
    <OptionsProvider>
      <RacRouterProvider>
        <div className="flex min-h-dvh flex-col">
          {/* The bar is inside <main>: it holds the page's <h1>, which is
              where focus goes on arrival (lib/route-focus.ts). */}
          <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
            <Routes>
              <Route index element={<ProtoIndex />} />
              <Route path="comp" element={<Competitions />} />
              <Route path="comp/new" element={<NewComp />} />
              <Route path="comp/corryong/scores" element={<Scores />} />
              <Route path="comp/corryong/settings" element={<CompSettings />} />
              <Route path="comp/corryong/settings/:group" element={<CompSettingsForm />} />
              <Route path="comp/corryong/pilots" element={<Pilots />} />
              <Route path="comp/corryong/pilots/new" element={<NewPilot />} />
              <Route path="comp/corryong/pilots/copy" element={<CopyPilots />} />
              <Route path="comp/corryong/pilots/:pilotId" element={<EditPilot />} />
              <Route path="comp/corryong/task/:taskId" element={<Task />} />
              <Route path="comp/corryong/task/:taskId/pilot/:pilotId" element={<ReportCard />} />
              <Route path="comp/corryong/task/:taskId/route" element={<RoutePage />} />
              <Route
                path="comp/corryong/task/:taskId/route/:turnpointId"
                element={<TurnpointPage />}
              />
              <Route path="comp/:compId" element={<CompHub />} />
              <Route path="me" element={<MyFlights />} />
              <Route path="submit" element={<SubmitTrack />} />
              <Route path="*" element={<Missing />} />
            </Routes>
          </main>
        </div>
      </RacRouterProvider>
    </OptionsProvider>
  );
}
