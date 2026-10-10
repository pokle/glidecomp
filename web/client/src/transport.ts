/**
 * Transport wrappers for a client that is not the website.
 *
 * There is no staging environment — branch previews share production's
 * workers — so a development build of the app that could write to
 * glidecomp.com is how a test competition ends up in the public activity log.
 * `guardWrites` makes that impossible in code: with writes disallowed, any
 * request that is not a read is refused before it leaves the device. It lives
 * here, around the transport, so no screen has to remember it.
 * See docs/2026-10-05-mobile-app-plan.md, "Which API a build talks to".
 */
import type { Fetch } from "./api";

/** A write a development build refused to send to production. */
export class WriteBlockedError extends Error {
  constructor(readonly method: string) {
    super(`${method} blocked: this development build reads production but never writes to it`);
    this.name = "WriteBlockedError";
  }
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/** `fetch` that lets reads through and refuses everything else when `writesAllowed` is false. */
export function guardWrites(fetch: Fetch, writesAllowed: boolean): Fetch {
  if (writesAllowed) return fetch;
  return (input, init) => {
    const method = methodOf(input, init);
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return fetch(input, init);
    return Promise.reject(new WriteBlockedError(method));
  };
}
