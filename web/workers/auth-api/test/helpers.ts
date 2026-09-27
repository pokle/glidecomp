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
  options: {
    body?: unknown;
    cookie?: string;
    raw?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
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

/**
 * Fold a response's Set-Cookie headers into a Cookie header value, the way a
 * browser's cookie jar would: a new value replaces the old one of the same
 * name, and an expired cookie (Max-Age=0) is removed.
 *
 * Needed wherever a test changes the account and reads it back: the
 * `session_data` cookie cache carries the user, so the route that changes it
 * re-issues that cookie, and a test that kept sending the old one would be
 * asserting on a copy no browser would still hold.
 */
export function applySetCookies(cookie: string, res: Response): string {
  const jar = new Map<string, string>();
  for (const pair of cookie.split(";")) {
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  for (const sc of res.headers.getSetCookie()) {
    const [pair, ...attrs] = sc.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
    if (expired) jar.delete(name);
    else jar.set(name, pair.slice(eq + 1).trim());
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
