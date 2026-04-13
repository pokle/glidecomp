import type { Env, AuthUser } from "./env";

/**
 * Verify an API key by calling auth-api's /api/auth/me endpoint
 * with the x-api-key header. The BetterAuth API key plugin with
 * enableSessionForAPIKeys resolves the key to a user session.
 */
export async function verifyApiKey(
  env: Env,
  key: string
): Promise<AuthUser | null> {
  const res = await env.AUTH_API.fetch(
    new Request("https://auth/api/auth/me", {
      headers: { "x-api-key": key },
    })
  );

  const data = (await res.json()) as { user: AuthUser | null };
  return data.user;
}

/**
 * Extract bearer token from Authorization header.
 */
export function extractBearerToken(
  headers: Headers
): string | null {
  const auth = headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  return auth.slice(7);
}
