/**
 * The session goes to this build's API origin and nowhere else, and a
 * refreshed cookie is folded back into the store.
 */
jest.mock('@/auth/client', () => {
  const memory = new Map<string, string>();
  return {
    COOKIE_KEY: 'glidecomp_cookie',
    memory,
    secureStorage: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      getItemAsync: async (k: string) => memory.get(k) ?? null,
      setItemAsync: async (k: string, v: string) => void memory.set(k, v),
    },
  };
});

import { clearStoredSession, hasStoredSession, sameOrigin, withSession } from '@/auth/session-fetch';

const ORIGIN = 'https://glidecomp.com';
const memory: Map<string, string> = jest.requireMock('@/auth/client').memory;

function stored(cookies: Record<string, { value: string; expires: string | null }>) {
  memory.set('glidecomp_cookie', JSON.stringify(cookies));
}

function fakeFetch(setCookie?: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response('{}', { headers: setCookie ? { 'set-cookie': setCookie } : {} });
  };
  return { fn, calls };
}

beforeEach(() => memory.clear());

it('attaches the stored session to the API origin, with the native jar off', async () => {
  stored({ '__Secure-better-auth.session_token': { value: 'tok', expires: null } });
  const { fn, calls } = fakeFetch();
  await withSession(fn, ORIGIN)(`${ORIGIN}/api/comp`);
  const headers = new Headers(calls[0].init?.headers);
  expect(headers.get('cookie')).toBe('__Secure-better-auth.session_token=tok');
  expect(calls[0].init?.credentials).toBe('omit');
});

it('never sends it anywhere else', async () => {
  stored({ '__Secure-better-auth.session_token': { value: 'tok', expires: null } });
  const { fn, calls } = fakeFetch();
  await withSession(fn, ORIGIN)('https://glidecomp.com.attacker.example/api/comp');
  await withSession(fn, ORIGIN)('https://api.mapbox.com/styles');
  for (const call of calls) expect(new Headers(call.init?.headers).get('cookie')).toBeNull();
});

it('leaves out a cookie past its expiry', async () => {
  stored({
    'better-auth.session_token': { value: 'tok', expires: null },
    'better-auth.session_data': { value: 'old', expires: '2000-01-01T00:00:00Z' },
  });
  const { fn, calls } = fakeFetch();
  await withSession(fn, ORIGIN)(`${ORIGIN}/api/auth/me`);
  expect(new Headers(calls[0].init?.headers).get('cookie')).toBe('better-auth.session_token=tok');
});

it('folds a refreshed session cache cookie back into the store', async () => {
  stored({ 'better-auth.session_token': { value: 'tok', expires: null } });
  const { fn } = fakeFetch('better-auth.session_data=fresh; Max-Age=300; Path=/; HttpOnly');
  await withSession(fn, ORIGIN)(`${ORIGIN}/api/auth/me`);
  const jar = JSON.parse(memory.get('glidecomp_cookie')!);
  expect(jar['better-auth.session_token'].value).toBe('tok');
  expect(jar['better-auth.session_data'].value).toBe('fresh');
});

it('knows whether a session is stored, and forgets it', async () => {
  expect(hasStoredSession()).toBe(false);
  stored({ 'better-auth.session_token': { value: 'tok', expires: null } });
  expect(hasStoredSession()).toBe(true);
  await clearStoredSession();
  expect(hasStoredSession()).toBe(false);
});

it('compares origins, not prefixes', () => {
  expect(sameOrigin('https://glidecomp.com/api', ORIGIN)).toBe(true);
  expect(sameOrigin('https://glidecomp.com:444/api', ORIGIN)).toBe(false);
  expect(sameOrigin('http://glidecomp.com/api', ORIGIN)).toBe(false);
  expect(sameOrigin('not a url', ORIGIN)).toBe(false);
});
