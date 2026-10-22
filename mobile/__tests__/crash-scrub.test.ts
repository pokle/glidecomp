import { bareUrl, scrubBreadcrumb, scrubEvent, withoutEmails } from '@/lib/crash-scrub';

describe('crash reports carry nothing personal', () => {
  test('a URL loses its query string and fragment', () => {
    expect(bareUrl('https://glidecomp.com/signin/app#otp=123456&email=a%40b.com')).toBe('https://glidecomp.com/signin/app');
    expect(bareUrl('https://glidecomp.com/api/comp/search?q=Bright')).toBe('https://glidecomp.com/api/comp/search');
  });

  test('an email address is replaced wherever it appears', () => {
    expect(withoutEmails('No pilot registered as jo.smith+hg@example.com.au')).toBe('No pilot registered as [email]');
  });

  test('an event with an email in it comes out without one, and without identity or bodies', () => {
    const event = {
      message: 'Upload refused for jo@example.com',
      user: { id: 'u1', email: 'jo@example.com' },
      server_name: 'Jos-iPhone',
      request: { url: 'https://glidecomp.com/api/x?email=jo@example.com', method: 'POST', data: '{"email":"jo@example.com"}', cookies: { s: '1' }, headers: { cookie: 's=1' } },
      exception: { values: [{ type: 'Error', value: 'jo@example.com is not registered' }] },
      extra: { nested: { deeper: ['contact jo@example.com'] } },
      breadcrumbs: [
        { category: 'console', message: 'jo@example.com' },
        { category: 'navigation', data: { from: '/me', to: '/comp/bright-1?class=open' } },
        { category: 'fetch', data: { method: 'GET', url: 'https://glidecomp.com/api/auth/me?x=1', status_code: 200, body: 'secret' } },
      ],
    };
    const out = scrubEvent(event);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/@example\.com/);
    expect(out).not.toHaveProperty('user');
    expect(out).not.toHaveProperty('server_name');
    expect(out.request).toEqual({ url: 'https://glidecomp.com/api/x', method: 'POST' });
    expect(out.breadcrumbs).toEqual([
      { category: 'navigation', data: { from: '/me', to: '/comp/bright-1' } },
      { category: 'fetch', data: { method: 'GET', url: 'https://glidecomp.com/api/auth/me', status_code: 200 } },
    ]);
    // The input is left alone.
    expect(event.user.email).toBe('jo@example.com');
  });

  test('console breadcrumbs are dropped', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'anything' })).toBeNull();
  });
});
