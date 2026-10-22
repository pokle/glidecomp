/**
 * What a crash report may carry (stage 10). Pure, so the rules are tested
 * without Sentry: `src/crash-reports.ts` hands every event and breadcrumb
 * through these before anything leaves the phone.
 *
 * - No identity: the user block goes, whatever set it.
 * - No bodies, cookies or headers of any request.
 * - No URL's query string or fragment — the sign-in link's code rides in a
 *   fragment, and a search names what someone looked for.
 * - No email address anywhere in the text that is left.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** A URL without its query string or fragment. */
export function bareUrl(url: string): string {
  return url.replace(/[?#].*$/, '');
}

/** Text with every email address replaced. */
export function withoutEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** A string anywhere in a JSON-shaped value, recursively scrubbed. */
function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return withoutEmails(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? bareUrl(value) : value);
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v, depth + 1);
  return out;
}

type Bag = Record<string, unknown>;

/** A Sentry event, minus anything personal. Returns a copy. */
export function scrubEvent<E extends Bag>(event: E): E {
  const e: Bag = { ...event };
  delete e.user;
  delete e.server_name;
  if (e.request && typeof e.request === 'object') {
    const r = e.request as Bag;
    e.request = typeof r.url === 'string' ? { url: bareUrl(r.url), method: r.method } : { method: r.method };
  }
  if (Array.isArray(e.breadcrumbs)) {
    e.breadcrumbs = (e.breadcrumbs as Bag[]).map((b) => scrubBreadcrumb(b)).filter((b) => b !== null);
  }
  for (const key of ['message', 'exception', 'extra', 'contexts', 'tags', 'transaction']) {
    if (key in e) e[key] = scrubValue(e[key]);
  }
  return e as E;
}

/**
 * A breadcrumb, minus anything personal, or null to drop it. Console output
 * is dropped outright: it is whatever a developer logged, and nobody vetted
 * it for a stranger's dashboard. Navigation keeps the screen; HTTP keeps the
 * method, bare URL and status.
 */
export function scrubBreadcrumb<B extends Bag>(crumb: B): B | null {
  if (crumb.category === 'console') return null;
  const b: Bag = { ...crumb };
  if (b.data && typeof b.data === 'object') {
    const d = b.data as Bag;
    const kept: Bag = {};
    for (const key of ['method', 'status_code', 'from', 'to', 'url']) {
      if (key in d) kept[key] = typeof d[key] === 'string' ? withoutEmails(bareUrl(d[key] as string)) : d[key];
    }
    b.data = kept;
  }
  if (typeof b.message === 'string') b.message = withoutEmails(b.message);
  return b as B;
}
