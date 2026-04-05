import { hc } from "hono/client";
import type { AppType } from "../../../workers/competition-api/src/index";

export const api = hc<AppType>("/");
