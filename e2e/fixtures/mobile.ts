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
  // score tables, the pilots grid and the activity feed.
  "comp-detail.spec.ts",
  // Submitting a track — the flow whose whole premise is a pilot who has just
  // landed, standing on a hill, holding a phone.
  "track-submission.spec.ts",
  // The routed task editors (#637) — settings, weather notes and the route
  // editor. Same reason as the comp settings pages: built mobile-first, and
  // the route editor is the surface that most needed it.
  "task-settings-pages.spec.ts",
] as const;

/** The same list as Playwright `testMatch` patterns. */
export const MOBILE_TEST_MATCH: string[] = MOBILE_SPEC_FILES.map(
  (file) => `**/${file}`
);
