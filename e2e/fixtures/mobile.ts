/**
 * Which specs the `mobile` Playwright project runs.
 *
 * The suite's other project, `chromium`, runs every spec at a desktop viewport
 * with a mouse. `mobile` re-runs the list below under a phone device
 * descriptor — narrow viewport, touch, mobile user agent, `isMobile` (so the
 * page's own `<meta name="viewport">` is honoured rather than ignored). See
 * playwright.config.ts for the descriptor and why it is that one.
 *
 * It is a LIST rather than "everything", because a second pass is not free:
 * the suite runs `workers: 1` (see the config), so every file named here adds
 * its own wall clock to the run, and the E2E job is already the long pole in
 * CI. The list is therefore the pages a pilot or organiser actually reaches
 * from a phone, which is what issue #643 asked for — competition settings,
 * the comp/scores pages, and track submission.
 *
 * The names are bare filenames, not globs, so that mobile.test.ts can check
 * each one against the directory. A spec renamed without touching this file
 * would otherwise drop out of mobile coverage in silence, and Playwright would
 * report it as a project with fewer tests rather than as an error.
 *
 * No import of `@playwright/test` here on purpose: this module is read by a
 * `bun test` guard, and the list is the only thing that guard needs.
 */

export const MOBILE_SPEC_FILES = [
  // The hierarchical competition settings pages — built mobile-first (#636),
  // so a desktop-only pass would test them at the one width they were not
  // designed for.
  "comp-settings-pages.spec.ts",
  // The comp and scores pages: the score-view tab strip (#640), the sortable
  // score tables, the pilots list and the activity feed.
  "comp-detail.spec.ts",
  // Submitting a track — the flow whose whole premise is a pilot who has just
  // landed, standing on a hill, holding a phone.
  "track-submission.spec.ts",
  // The routed task editors (#637) — settings, weather notes and the route
  // editor. Same reason as the comp settings pages: built mobile-first, and
  // the route editor is the surface that most needed it.
  "task-settings-pages.spec.ts",
  // Create a test IGC (#822), a page under the task where it was a dialog —
  // because a dialog with text fields is what misbehaved on a phone.
  "task-test-igc.spec.ts",
  // The waypoints page, whose editor is a list of waypoints opening
  // full-screen sheets, at every width — the Tabulator grid it replaced did
  // not work at this one. This project is what holds that: the page is
  // asserted never to scroll sideways, and a sheet to be dismissable with the
  // back gesture.
  "comp-waypoints.spec.ts",
  // The pilots page, the same shape as the waypoints page for the same reason:
  // a list of pilots opening sheets, with search and + at the bottom of the
  // screen in thumb reach. The fourteen-column grid it replaced showed about
  // one and a half columns at this width.
  "comp-pilots.spec.ts",
  // The kit form (rac/form.tsx), whose rules are about where an error lands
  // on the screen — which is exactly what a phone's height, its keyboard and
  // a sheet's fixed header change.
  "forms.spec.ts",
] as const;

/** The same list as Playwright `testMatch` patterns. */
export const MOBILE_TEST_MATCH: string[] = MOBILE_SPEC_FILES.map(
  (file) => `**/${file}`
);
