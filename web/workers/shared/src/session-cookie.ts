/**
 * Who is signed in, answered from the request's own cookies — no auth hop.
 *
 * auth-api runs Better Auth with `session.cookieCache` on the `"jwt"` strategy
 * and the jwt plugin's `sessionCookieCache` (see auth-api/src/auth.ts). Every
 * time auth-api reads a session from D1 it also sets a short-lived
 * `session_data` cookie: a JWT carrying the session and user, signed with an
 * asymmetric key whose PRIVATE half never leaves auth-api. The public half is
 * published at `GET /api/auth/jwks`.
 *
 * So another worker can check that cookie with the public key alone. It needs
 * no `BETTER_AUTH_SECRET` and holds nothing that could sign a session, so a
 * bug in that worker cannot leak a way to forge one. Before this, every
 * signed-in request to competition-api (and every SSR page render) paid a
 * service-binding hop to `/api/auth/me` and two sequential D1 reads — about
 * half of all signed-in worker invocations.
 *
 * It lives in the kit because two callers must apply exactly the same checks
 * (competition-api's auth middleware and the SSR Pages Function), and one of
 * them quietly accepting a cookie the other refuses would be a bug that
 * nothing would catch.
 *
 * **A miss is "ask auth-api", never "signed out".** The cache cookie expires
 * after a few minutes while the session itself lives for 60 days. So every
 * answer here other than a verified user is `undefined`, and the caller falls
 * back to the `/api/auth/me` hop, which re-reads D1 and re-issues the cookie.
 * The mirror of issue #481: the absence of a cached answer is not an answer.
 *
 * The checks mirror Better Auth's own `getCookieCache()` with a JWKS, plus the
 * one its `getSession` makes and that helper does not: the cached session must
 * belong to the `session_token` cookie beside it.
 */
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

/** Better Auth's default cookie prefix; auth-api does not change it. */
const COOKIE_PREFIX = "better-auth.";
/** Better Auth prefixes every cookie with this when served over https. */
const SECURE_PREFIX = "__Secure-";

const SESSION_TOKEN = `${COOKIE_PREFIX}session_token`;
const SESSION_DATA = `${COOKIE_PREFIX}session_data`;

/** The `typ` and `aud` Better Auth's jwt plugin stamps on a session-cache JWT
 * (better-auth/dist/cookies/jwt.mjs). A JWT signed by the same key for any
 * other purpose carries neither, so cannot be replayed as a session. */
const SESSION_JWT_TYP = "better-auth.session-cache+jwt";
const SESSION_JWT_AUD = "better-auth:session-cache";

/** The asymmetric algorithms the jwt plugin can mint keys for. The algorithm
 * is taken from the published KEY, never from the token's header, and only
 * ever one of these: `none` and the HMAC family are refused outright. */
const ALLOWED_ALGS = new Set(["EdDSA", "ES256", "ES512", "RS256", "PS256"]);

/** The cached session version Better Auth writes when `cookieCache.version`
 * is unset. A different value means auth-api has retired the format. */
const SESSION_CACHE_VERSION = "1";

/** How long a fetched key set is trusted before it is re-read. Keys rotate
 * rarely; a kid we have not seen triggers an early refresh regardless. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** A kid we have never seen refreshes the set at most this often, so a stream
 * of forged kids cannot turn every request into a JWKS fetch. */
const JWKS_UNKNOWN_KID_REFRESH_MS = 30 * 1000;

/** The account fields every GlideComp worker reads off a session. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
}

/**
 * The `Cookie` header reduced to Better Auth's own cookies, or `null` when
 * none remain.
 *
 * Only these can identify anyone, so they are all an auth hop needs — and a
 * request carrying only an analytics or `__cf_bm` cookie is an anonymous
 * visitor, not one to spend an auth hop (and an uncacheable page) on.
 */
export function authCookieHeader(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const kept = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return false;
      const name = part.slice(0, eq).trim();
      return (
        name.startsWith(COOKIE_PREFIX) ||
        name.startsWith(SECURE_PREFIX + COOKIE_PREFIX)
      );
    });
  return kept.length > 0 ? kept.join("; ") : null;
}

function parseCookies(header: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    // First wins, as in a browser's own ordering (most specific path first).
    if (!out.has(name)) out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

function readCookie(cookies: Map<string, string>, name: string): string | undefined {
  return cookies.get(SECURE_PREFIX + name) ?? cookies.get(name);
}

/** A cookie Better Auth may have split into `name.0`, `name.1`, … when it
 * outgrew the 4 KB limit (better-auth/dist/cookies/index.mjs). */
function readChunkedCookie(cookies: Map<string, string>, name: string): string | undefined {
  const whole = readCookie(cookies, name);
  if (whole) return whole;
  const chunks: { index: number; value: string }[] = [];
  for (const [key, value] of cookies) {
    const base = key.startsWith(SECURE_PREFIX) ? key.slice(SECURE_PREFIX.length) : key;
    if (!base.startsWith(name + ".")) continue;
    const index = Number(base.slice(name.length + 1));
    if (Number.isInteger(index) && index >= 0) chunks.push({ index, value });
  }
  if (chunks.length === 0) return undefined;
  chunks.sort((a, b) => a.index - b.index);
  return chunks.map((c) => c.value).join("");
}

/** The raw session token inside the signed `session_token` cookie
 * (`<token>.<hmac>`, URL-encoded). The HMAC needs the secret we deliberately
 * do not hold; the token is only compared against the signed JWT's `sid`. */
function sessionTokenOf(cookies: Map<string, string>): string | undefined {
  const raw = readCookie(cookies, SESSION_TOKEN);
  if (!raw) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const dot = value.lastIndexOf(".");
  return dot > 0 ? value.slice(0, dot) : undefined;
}

// ── the key set ──────────────────────────────────────────────────────────────

type VerifyKey = Awaited<ReturnType<typeof importJWK>>;
interface KeySet {
  keys: Map<string, { alg: string; jwk: JWK; imported?: Promise<VerifyKey> }>;
  fetchedAt: number;
}

/** Per isolate. Keys are public, so sharing them across requests is safe. */
let keySet: KeySet | null = null;
let inflight: Promise<KeySet | null> | null = null;

async function loadKeySet(fetchJwks: () => Promise<Response>): Promise<KeySet | null> {
  inflight ??= (async () => {
    try {
      const res = await fetchJwks();
      if (!res.ok) return null;
      const body = (await res.json()) as { keys?: (JWK & { kid?: string; alg?: string })[] };
      const keys: KeySet["keys"] = new Map();
      for (const jwk of body.keys ?? []) {
        if (!jwk.kid || !jwk.alg || !ALLOWED_ALGS.has(jwk.alg)) continue;
        // Public members only. Should a private one ever appear, this worker
        // would still not hold a copy of it.
        const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, k: _k, ...pub } = jwk;
        keys.set(jwk.kid, { alg: jwk.alg, jwk: pub });
      }
      keySet = { keys, fetchedAt: Date.now() };
      return keySet;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function keyFor(
  kid: string,
  fetchJwks: () => Promise<Response>
): Promise<{ alg: string; key: VerifyKey } | undefined> {
  const now = Date.now();
  let set = keySet;
  const age = set ? now - set.fetchedAt : Infinity;
  if (!set || age > JWKS_TTL_MS || (!set.keys.has(kid) && age > JWKS_UNKNOWN_KID_REFRESH_MS)) {
    set = (await loadKeySet(fetchJwks)) ?? set;
  }
  const entry = set?.keys.get(kid);
  if (!entry) return undefined;
  entry.imported ??= importJWK(entry.jwk, entry.alg);
  try {
    return { alg: entry.alg, key: await entry.imported };
  } catch {
    entry.imported = undefined;
    return undefined;
  }
}

/** Tests only: forget the isolate's key set. */
export function resetSessionKeyCache(): void {
  keySet = null;
  inflight = null;
}

// ── verification ─────────────────────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The signed-in user, when the request carries a valid session-cache cookie;
 * `undefined` for anything else ("can't tell here — ask auth-api").
 *
 * `fetchJwks` fetches auth-api's `GET /api/auth/jwks` — over the service
 * binding, so it never leaves Cloudflare. It is called once per isolate per
 * hour, and early only for a key id not seen before.
 */
export async function verifySessionCookie(
  cookieHeader: string | null | undefined,
  fetchJwks: () => Promise<Response>
): Promise<SessionUser | undefined> {
  if (!cookieHeader) return undefined;
  const cookies = parseCookies(cookieHeader);
  const jwt = readChunkedCookie(cookies, SESSION_DATA);
  const token = sessionTokenOf(cookies);
  // Better Auth's getSession refuses a cached session with no session_token
  // beside it (sign-out clears both), and so does this.
  if (!jwt || !token) return undefined;

  try {
    const header = decodeProtectedHeader(jwt);
    if (header.typ !== SESSION_JWT_TYP || typeof header.kid !== "string") return undefined;
    const key = await keyFor(header.kid, fetchJwks);
    // The key decides the algorithm; a header naming another one (HS256
    // signed with a guessed secret, `none`) is refused before any crypto.
    if (!key || header.alg !== key.alg) return undefined;

    const { payload } = await jwtVerify(jwt, key.key, {
      algorithms: [key.alg],
      audience: SESSION_JWT_AUD,
      clockTolerance: 5,
      requiredClaims: ["exp", "sub", "sid"],
    });

    const session = asRecord(payload.session);
    const user = asRecord(payload.user);
    if (!session || !user) return undefined;
    if ((payload.version ?? SESSION_CACHE_VERSION) !== SESSION_CACHE_VERSION) return undefined;
    // The token, the JWT's claims and its embedded session must all agree:
    // this cached session is the one the session_token cookie names.
    if (payload.sid !== token || session.token !== token) return undefined;
    if (typeof user.id !== "string" || payload.sub !== user.id || session.userId !== user.id) {
      return undefined;
    }
    // The session itself may end before the cache does.
    const expiresAt = Date.parse(String(session.expiresAt));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return undefined;
    if (typeof user.email !== "string" || typeof user.name !== "string") return undefined;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      image: typeof user.image === "string" ? user.image : null,
      username: typeof user.username === "string" ? user.username : null,
    };
  } catch {
    return undefined;
  }
}
