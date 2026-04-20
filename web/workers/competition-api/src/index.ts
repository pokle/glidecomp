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

app.use(
  "/api/comp/*",
  cors({
    origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : ""),
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Mount routes — igcRoutes first to avoid potential conflicts
const routes = app
  .route("/", igcRoutes)
  .route("/", pilotRoutes)
  .route("/", pilotStatusRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", scoreRoutes)
  .route("/", auditRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
};
