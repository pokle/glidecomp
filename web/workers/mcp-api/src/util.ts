import type { Env, AuthUser } from "./env";

/**
 * Forward a request to the competition-api via service binding.
 * The user is passed as a cookie-authenticated session by proxying
 * through the auth-api — but since the mcp-api already resolved
 * the user from the API key, we forge a synthetic cookie header
 * that the competition-api's auth middleware will accept.
 *
 * Actually, the competition-api auth middleware calls auth-api's
 * /api/auth/me to verify the cookie. Since we don't have a real
 * session cookie, we instead set a special header that the
 * competition-api can use. However, the simpler approach is to
 * create a real session... but that's complex.
 *
 * Simplest approach: we extend the auth-api /api/auth/me endpoint
 * to also accept an X-Api-Key header and resolve the user from it.
 * But that changes the existing auth flow.
 *
 * Even simpler: the MCP worker calls competition-api endpoints
 * directly via service binding, passing a synthetic internal header
 * with the resolved user JSON. The competition-api auth middleware
 * already calls auth-api via service binding — we'll add a shortcut:
 * if an X-MCP-User header is present (only possible via service
 * binding, not from the internet), trust it.
 *
 * Actually the cleanest approach: we have the MCP worker pass the
 * API key in the Authorization header, and modify the competition-api
 * auth middleware to also try verifying via API key if no cookie session.
 *
 * Let's go with the simplest: pass a trusted internal header.
 * Service bindings are internal-only (not reachable from the internet),
 * so this is safe.
 */

const INTERNAL_USER_HEADER = "X-Glidecomp-Internal-User";

/**
 * Make a request to the competition-api, authenticating as the given user.
 */
export async function compApi(
  env: Env,
  user: AuthUser | null,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {};

  if (user) {
    headers[INTERNAL_USER_HEADER] = JSON.stringify(user);
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await env.COMPETITION_API.fetch(
    new Request(`https://comp${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );

  const data = await res.json();

  if (!res.ok) {
    const err = data as { error?: string };
    throw new Error(err.error ?? `API error ${res.status}`);
  }

  return data;
}

/**
 * Make a raw request to the competition-api (for binary responses like IGC downloads).
 */
export async function compApiRaw(
  env: Env,
  user: AuthUser | null,
  method: string,
  path: string,
  body?: BodyInit,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const headers: Record<string, string> = { ...extraHeaders };

  if (user) {
    headers[INTERNAL_USER_HEADER] = JSON.stringify(user);
  }

  return env.COMPETITION_API.fetch(
    new Request(`https://comp${path}`, {
      method,
      headers,
      body,
    })
  );
}

/**
 * Format an API response as MCP tool result content.
 */
export function jsonResult(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

/**
 * Format an error as MCP tool result.
 */
export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}
