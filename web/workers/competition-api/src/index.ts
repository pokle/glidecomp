import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AuthUser } from "./env";
import { compRoutes } from "./routes/comp";
import { taskRoutes } from "./routes/task";
import { igcRoutes } from "./routes/igc";
import { pilotRoutes } from "./routes/pilot";

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

// Mount routes — pilotRoutes first so /api/comp/pilot is matched
// before /api/comp/:comp_id
const routes = app
  .route("/", pilotRoutes)
  .route("/", compRoutes)
  .route("/", taskRoutes)
  .route("/", igcRoutes);

export type AppType = typeof routes;
export default app;
