import { SELF } from "cloudflare:test";

/**
 * Sign in via the dev-login endpoint and return a Cookie header value usable
 * for subsequent authenticated requests.
 *
 * Better Auth issues cookies via Set-Cookie. We strip attributes (Path, HttpOnly,
 * Expires, etc.) and join the bare name=value pairs with "; " — that's the
 * format the Cookie request header wants.
 */
export async function loginAs(
  email: string,
  name: string = email
): Promise<string> {
  const res = await SELF.fetch("https://test/api/auth/dev-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, name }),
  });
  if (!res.ok) {
    throw new Error(
      `dev-login failed: ${res.status} ${await res.text().catch(() => "")}`
    );
  }
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length === 0) {
    throw new Error("dev-login returned no Set-Cookie headers");
  }
  return setCookies.map((sc) => sc.split(";")[0]).join("; ");
}

/** Make a request to the worker. Pass `cookie` from loginAs() to authenticate. */
export async function request(
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; raw?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined || options.raw !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (options.cookie) {
    headers["Cookie"] = options.cookie;
  }

  const body =
    options.raw !== undefined
      ? options.raw
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : undefined;

  return SELF.fetch(`https://test${path}`, { method, headers, body });
}
