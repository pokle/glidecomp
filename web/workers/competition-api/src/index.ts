import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, AuthUser } from "./env";
import { compRoutes } from "./routes/comp";

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

// Mount comp routes
const routes = app.route("/", compRoutes);

export type AppType = typeof routes;
export default app;
