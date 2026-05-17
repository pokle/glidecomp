import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AuthUser } from "./env";
import { compRoutes } from "./routes/comp";
import { taskRoutes } from "./routes/task";
import { igcRoutes } from "./routes/igc";
import { pilotRoutes } from "./routes/pilot";
import { pilotStatusRoutes } from "./routes/pilot-status";
import { scoreRoutes } from "./routes/score";
import { auditRoutes } from "./routes/audit";
import { userFilesRoutes } from "./routes/user-files";

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
  // Custom response headers we want the browser to surface to JS. These are
  // used by the user-files download endpoints so the frontend can recover the
  // original filename and display name without an extra metadata round-trip.
  exposeHeaders: ["X-Filename", "X-Display-Name"],
});

app.use("/api/comp/*", corsConfig);
app.use("/api/user/*", corsConfig);
app.use("/api/u/*", corsConfig);

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
  .route("/", pilotRoutes)
  .route("/", pilotStatusRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", scoreRoutes)
  .route("/", auditRoutes)
  .route("/", userFilesRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
};
