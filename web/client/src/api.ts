/**
 * The typed competition-api client, for any origin and any transport.
 *
 * The website calls its own origin with cookies (`createApi("/", …)` in
 * comp/api.ts); the app calls glidecomp.com or the local workers through its
 * own transport, which also carries the retry rules and the development
 * build's write guard. The route types come from the worker itself, so a
 * renamed route or a changed response is a type error in both clients.
 */
import { hc } from "hono/client";
import type { AppType } from "../../workers/competition-api/src/index";

export type { AppType };

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createApi(baseUrl: string, fetch: Fetch) {
  return hc<AppType>(baseUrl, { fetch });
}

export type Api = ReturnType<typeof createApi>;
