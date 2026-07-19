import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES } from "./igc-validation";
import type { Env, AuthUser } from "./env";
import { compRoutes } from "./routes/comp";
import { taskRoutes } from "./routes/task";
import { waypointsRoutes } from "./routes/waypoints";
import { igcRoutes } from "./routes/igc";
import { pilotRoutes } from "./routes/pilot";
import { pilotStatusRoutes } from "./routes/pilot-status";
import { manualFlightRoutes } from "./routes/manual-flight";
import { scoreRoutes } from "./routes/score";
import { fieldAnalysisRoutes } from "./routes/field-analysis";
import { auditRoutes } from "./routes/audit";
import { userFilesRoutes } from "./routes/user-files";
import { visualizationRoutes } from "./routes/visualization";
import { adminRoutes } from "./routes/admin";
import { cacheRoutes } from "./routes/cache";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS — credentials:true means we MUST NOT reflect arbitrary origins, or any
// site the user visits can make authenticated requests. Allowlist is prod +
// Pages preview deploys + localhost (for bun run dev against a live backend).
const PAGES_PREVIEW = /^https:\/\/[a-z0-9-]+\.glidecomp\.pages\.dev$/;
function isAllowedOrigin(origin: string): boolean {
  if (origin === "https://glidecomp.com") return true;
  if (PAGES_PREVIEW.test(origin)) return true;
  try {
    if (new URL(origin).hostname === "localhost") return true;
  } catch {
    /* malformed Origin — reject */
  }
  return false;
}

const corsConfig = cors({
  origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ""),
  credentials: true,
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "x-filename"],
  // Custom response headers we want the browser to surface to JS. X-Filename/
  // X-Display-Name are used by the user-files download endpoints so the
  // frontend can recover the original filename and display name without an
  // extra metadata round-trip. ETag/X-Cache back the score endpoints'
  // conditional re-score polling (ETag is not on the CORS safelist, so
  // cross-origin dev against a live backend needs it exposed explicitly).
  exposeHeaders: ["X-Filename", "X-Display-Name", "ETag", "X-Cache"],
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

// Mount routes — igcRoutes first to avoid potential conflicts
const routes = app
  .route("/", igcRoutes)
  .route("/", visualizationRoutes)
  .route("/", pilotRoutes)
  .route("/", pilotStatusRoutes)
  .route("/", manualFlightRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", waypointsRoutes)
  .route("/", scoreRoutes)
  .route("/", fieldAnalysisRoutes)
  .route("/", auditRoutes)
  .route("/", userFilesRoutes)
  .route("/", adminRoutes)
  .route("/", cacheRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
};
