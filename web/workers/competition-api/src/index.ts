import { Hono } from "hono";
import { cors } from "hono/cors";
// credentials:true means we MUST NOT reflect arbitrary origins — the
// allowlist is shared with the other Workers so it cannot drift.
import { allowedOrigin } from "@glidecomp/worker-kit/cors";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES } from "./igc-validation";
import type { AuthedEnv, Env } from "./env";
import { compRoutes } from "./routes/comp";
import { lookupRoutes } from "./routes/lookup";
import { searchRoutes } from "./routes/search";
import { drainSearchIndex, sweepSearchIndex } from "./search-index";
import { taskRoutes } from "./routes/task";
import { waypointsRoutes } from "./routes/waypoints";
import { igcRoutes } from "./routes/igc";
import { igcAnonRoutes } from "./routes/igc-anon";
import { openCompsRoutes } from "./routes/open-comps";
import { registrationRoutes } from "./routes/registration";
import { pilotRoutes } from "./routes/pilot";
import { pilotProfileRoutes } from "./routes/pilot-profile";
import { pilotStatusRoutes } from "./routes/pilot-status";
import { manualFlightRoutes } from "./routes/manual-flight";
import { scoreRoutes } from "./routes/score";
import { fieldAnalysisRoutes } from "./routes/field-analysis";
import { weatherRoutes } from "./routes/weather";
import { auditRoutes } from "./routes/audit";
import { userFilesRoutes } from "./routes/user-files";
import { visualizationRoutes } from "./routes/visualization";
import { adminRoutes } from "./routes/admin";
import { cacheRoutes } from "./routes/cache";
import { civlRankingsRoutes } from "./routes/civl-rankings";

const app = new Hono<AuthedEnv>();


const corsConfig = cors({
  origin: allowedOrigin,
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // x-pilot-ident-kind / x-pilot-ident carry the identifier on the anonymous
  // submit route. Without them here every browser preflight for that route
  // fails — and only in a real browser, never in the worker tests.
  allowHeaders: [
    "Content-Type",
    "Authorization",
    "x-filename",
    "x-pilot-ident-kind",
    "x-pilot-ident",
    "x-comp-pilot",
  ],
  // Custom response headers we want the browser to surface to JS. X-Filename/
  // X-Display-Name are used by the user-files download endpoints so the
  // frontend can recover the original filename and display name without an
  // extra metadata round-trip. ETag/X-Cache back the score endpoints'
  // conditional re-score polling (ETag is not on the CORS safelist, so
  // cross-origin dev against a live backend needs it exposed explicitly).
  // Retry-After lets the submit dialog say how long a rate-limited pilot has
  // to wait rather than guessing.
  exposeHeaders: [
    "X-Filename",
    "X-Display-Name",
    "ETag",
    "X-Cache",
    "Retry-After",
  ],
});

app.use("/api/comp/*", corsConfig);
app.use("/api/user/*", corsConfig);
app.use("/api/u/*", corsConfig);
app.use("/api/admin/*", corsConfig);

// Cap request-body size at the HTTP layer so oversize bodies are rejected
// while streaming, before any handler buffers them (c.req.arrayBuffer() /
// c.req.json() would otherwise allocate up to the 100 MB Workers ceiling).
// The cap sits just above the IGC compressed cap so validateAndDecompressIgc
// stays the user-facing error at the 1 MiB boundary; the largest JSON body
// any validator admits (bulk pilots: 250 entries of bounded text) is
// comfortably below it.
app.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  })
);

// Surface uncaught handler errors as JSON instead of Hono's bare
// "Internal Server Error" body. Logs the stack server-side (visible in
// wrangler tail / vitest console) and returns the message to the client so
// e2e traces and the dev console can identify the cause without ssh access
// to the worker. The stack itself is kept server-side.
app.onError((err, c) => {
  console.error("[competition-api] unhandled error", err);
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
});

/** Reindex passes run after a mutation (40 documents each). */
const DRAIN_PASSES_PER_MUTATION = 2;
/** Reindex passes run per cron tick — the backstop, so it may work harder. */
const DRAIN_PASSES_PER_CRON = 50;
/** The cron that looks for documents nothing marked dirty. Must match the
 *  second entry of `crons` in wrangler.toml. */
const NIGHTLY_SWEEP_CRON = "43 3 * * *";

// Keep the search index in step with the write that just happened.
//
// Unlike audit() and bumpAndRevalidateScores(), which every mutating handler
// must remember to call, search documents derive from columns the database
// can watch itself: triggers (migration 0026) queue the keys, and this drains
// the queue once per mutation. One place instead of twenty-eight, and a
// handler added next year is indexed without anyone remembering it.
//
// Awaited rather than deferred, so a competition created by a request is
// findable by the request after it. The cost is one SELECT against a table
// that is almost always empty.
app.use("*", async (c, next) => {
  await next();
  const method = c.req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  await drainSearchIndex(c.env.DB, DRAIN_PASSES_PER_MUTATION);
});

// Mount routes — igcRoutes first to avoid potential conflicts
const routes = app
  // Ahead of igcRoutes: the anonymous submit route's literal "open-submit"
  // leaf must win over the on-behalf route's :comp_pilot_id param.
  .route("/", igcAnonRoutes)
  .route("/", igcRoutes)
  .route("/", visualizationRoutes)
  // Ahead of pilotRoutes: the account's own /api/comp/pilot must win over
  // the roster's /api/comp/:comp_id/pilot.
  .route("/", pilotProfileRoutes)
  .route("/", pilotRoutes)
  .route("/", pilotStatusRoutes)
  .route("/", manualFlightRoutes)
  // Ahead of compRoutes: /api/comp/lookup, /api/comp/search and
  // /api/comp/open-now must win over /api/comp/:comp_id.
  .route("/", lookupRoutes)
  .route("/", searchRoutes)
  .route("/", openCompsRoutes)
  // Also ahead of compRoutes: /api/comp/:comp_id/registration/resolve would
  // otherwise be shadowed by comp's own :comp_id routes.
  .route("/", registrationRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", waypointsRoutes)
  .route("/", scoreRoutes)
  .route("/", fieldAnalysisRoutes)
  .route("/", weatherRoutes)
  .route("/", auditRoutes)
  .route("/", userFilesRoutes)
  .route("/", adminRoutes)
  .route("/", cacheRoutes)
  .route("/", civlRankingsRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,

  /**
   * The search index's backstops (see ./search-index.ts).
   *
   * Hourly: drain whatever the mutation middleware left behind — a bulk pilot
   * import queues more keys than one request should spend time on.
   *
   * Nightly: also sweep for documents that are missing or were written by an
   * older builder. The triggers cannot miss a change, but a deploy that
   * changes what a document contains leaves every existing row describing the
   * old shape, and this is what makes that heal on its own.
   */
  async scheduled(controller, env: Env, _ctx) {
    let swept = 0;
    if (controller.cron === NIGHTLY_SWEEP_CRON) {
      swept = await sweepSearchIndex(env.DB);
    }
    const drained = await drainSearchIndex(env.DB, DRAIN_PASSES_PER_CRON);
    console.log(
      `[search] cron ${controller.cron}: ${swept} documents swept, ${drained} rebuilt`
    );
  },
} satisfies ExportedHandler<Env>;
