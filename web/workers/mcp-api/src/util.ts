import type { Env } from "./env";

/**
 * Forward a request to competition-api via service binding.
 *
 * Auth model: pass through whichever credential the MCP client sent.
 * In practice that's the Better Auth API key (`Bearer glc_…` from the
 * MCP client), which we forward as `x-api-key` so competition-api's
 * auth middleware can resolve it via auth-api the same way it resolves
 * a browser cookie. Anonymous callers send no `apiKey` and only see
 * public endpoints.
 *
 * Do NOT forge identity headers here — that's what SEC-10 was about.
 */

function buildHeaders(
  apiKey: string | null,
  hasBody: boolean
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  if (hasBody) headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * Make a request to competition-api as the caller identified by `apiKey`.
 */
export async function compApi(
  env: Env,
  apiKey: string | null,
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await env.COMPETITION_API.fetch(
    new Request(`https://comp${path}`, {
      method,
      headers: buildHeaders(apiKey, body !== undefined),
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
 * Make a raw request to competition-api (for binary responses like IGC downloads).
 */
export async function compApiRaw(
  env: Env,
  apiKey: string | null,
  method: string,
  path: string,
  body?: BodyInit,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const headers: Record<string, string> = {
    ...extraHeaders,
    ...buildHeaders(apiKey, false),
  };

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
