# Ionic proof of concept

A **throwaway** mobile-first GlideComp, rebuilt on [Ionic Framework](https://ionicframework.com/) 8 + React. It does not call APIs. Data is mocked from Corryong Cup 2026. The point is to **feel** the kit: tabs, sheets, swipe, action sheets, large titles, and iOS vs Material — and to decide whether a wholesale switch is worth it.

This package is **not** a workspace member. It has its own `node_modules` so Ionic 9’s React Router v6 does not collide with the main app’s React Router v7.

## Run

From the repo root:

```bash
bun run dev:ionic-poc
```

Or:

```bash
cd web/ionic-poc
bun install
bun run dev
```

Then open [http://localhost:3100](http://localhost:3100). On a laptop the app sits in a phone frame. On a phone it goes full-bleed. Port **3100** so it does not fight Vite on 3000.

The bar above the phone:

- **iOS / Material** — Ionic’s two looks. GlideComp’s tokens already follow Apple, so iOS is the honest default.
- **Light / Dark / Auto**
- **Pilot / Organiser** — organisers get FABs, the pilots roster, route editor, recompute, altitude check.

## Suggested tour

1. **Comps** — search, filter chips, pull to refresh. Open **Corryong Cup 2026**.
2. **Hub** — map placeholder, fact chips, scores podium, tasks grouped by day (accordion). Share is an action sheet.
3. **Task 2 — Open** — turnpoint list with head/tail wind badges, submit / 3D replay / download.
4. **Scores** — class segment, list (not a spreadsheet), tap **Jon Durand**.
5. **Report card** — accordion of GAP sections with substituted arithmetic, emphasis chart, track-cleaning chart.
6. **Waypoints** — whole-row locate; as organiser, tap a row for a sheet, **Check altitudes** for the review.
7. **Submit** — file drop, pickers, “submitting as”.
8. **Flights** — swipe left to delete (confirm alert), storage meter.
9. **Me → Settings** — grouped iOS-style units and theme.
10. **Me → Component gallery** — every control in one scroll.
11. Flip **Material** and **Dark** and walk the same path again.

Sign-in is at `/signin`. Email any address, then code `123456`.

## What is represented

| GlideComp job | Ionic shape |
|---|---|
| Global nav (Competitions / My Flights / Submit) | Bottom `IonTabBar` |
| Comp list + create | Searchbar, chips, list, FAB, modal |
| Comp hub | Large title, chips, accordion, podium, action sheet |
| Task briefing | Map placeholder, turnpoint list, buttons |
| Scores | Segments + list (thumb-scroll, not a grid) |
| Report card | Accordion + arithmetic + charts |
| Waypoints | List + sheet modal + altitude review |
| Submit track | Drop zone, selects, toast |
| My Flights | Sliding items, progress, alert |
| Settings | Grouped lists, action-sheet selects |
| Sign in | Email + OTP boxes |
| Task analysis | Contents list of boxes |
| Pilots (admin) | Swipe for DNF/absent/remove |
| Route editor | Reorder group |
| Weather | Range + notes |
| Loading / empty / confirm | Spinner, skeleton, alert, toast, refresher |

Maps and 3D replay are **placeholders**. A real switch still needs Mapbox / Three, same as today.

## What a wholesale switch would cost

Worth knowing before the feeling of the demo decides you.

**Ionic is good at** native phone chrome: tabs that keep their stack, swipe-back, sheets, action sheets, 44px rows, iOS grouped lists. That is the hill-in-the-hand job. GlideComp’s own tokens are already Apple-like, so Ionic iOS mode looks like a relative, not a stranger.

**Ionic fights the current stack.**

- `@ionic/react-router` on Ionic 9 needs **React Router v6**. The SPA is on v7. That is closer than v5 was, but it is still a router rewrite, not a restyle. Ionic says v7 is on their roadmap.
- The eight public comp pages are **SSR’d** for crawlers and first paint. Ionic is a client SPA. You would keep a separate SSR surface (the Astro + Pages Function path) or give up that SEO, or do a lot of custom work.
- The RAC kit was chosen for **accessibility**. Ionic is decent; it is not react-aria. Focus, keyboard grids, and “a failure to ask is not an answer” would all need re-proving.
- **Tabulator** (pilots grid) and **Mapbox** do not come with Ionic. The POC replaces the grid with a list on purpose — that is the mobile-first call already made for waypoints. A desktop organiser may still want a spreadsheet.
- One kit is the standing rule. Running RAC *and* Ionic is the mishmash this POC exists to avoid. Hybrid “Ionic on the phone, RAC on the desktop” is two apps.

**A cheaper experiment than wholesale:** keep RAC, and copy the interaction patterns this POC proves (bottom tabs, sheets, swipe, action sheets, list-not-grid). The waypoints page already did that without Ionic. The question this POC answers is whether Ionic’s *feel* is enough better to pay for the rewrite.

## Build

```bash
bun run --cwd web/ionic-poc build
```
