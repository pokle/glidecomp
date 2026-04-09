import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AuthUser } from "./env";
import { compRoutes } from "./routes/comp";
import { taskRoutes } from "./routes/task";
import { igcRoutes } from "./routes/igc";
import { pilotRoutes } from "./routes/pilot";
import { scoreRoutes } from "./routes/score";
import { auditRoutes } from "./routes/audit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// CORS for local dev (credentials needed for cookies)
app.use(
  "/api/comp/*",
  cors({
    origin: (origin) => origin ?? "",
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Mount routes — igcRoutes first to avoid potential conflicts
const routes = app
  .route("/", igcRoutes)
  .route("/", pilotRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", scoreRoutes)
  .route("/", auditRoutes);

export type AppType = typeof routes;

export default {
  fetch: app.fetch,
};
