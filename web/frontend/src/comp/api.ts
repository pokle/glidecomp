/**
 * The typed competition-api client. The route types come from the worker
 * itself, so a renamed route or a changed response is a type error here.
 */
import { hc } from "hono/client";
import type { AppType } from "../../../workers/competition-api/src/index";

export type { AppType };

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createApi(baseUrl: string, fetch: Fetch) {
  return hc<AppType>(baseUrl, { fetch });
}

export type Api = ReturnType<typeof createApi>;

/** The website's client: its own origin, with cookies. */
export const api = createApi("/", (input, init) =>
  fetch(input, { ...init, credentials: "include" })
);
