/**
 * Which API this build talks to, and whether it may write to it
 * (docs/2026-10-05-mobile-app-plan.md, "Which API a build talks to").
 *
 * EXPO_PUBLIC_API_ORIGIN picks the origin; unset, it is production. A
 * development build may read production but never write to it: a release
 * build (preview, beta, store) may, and so may any build pointed at the local
 * workers, whose data is the developer's own.
 */
export const API_ORIGIN = (process.env.EXPO_PUBLIC_API_ORIGIN ?? 'https://glidecomp.com').replace(
  /\/$/,
  '',
);

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/;

export const API_IS_LOCAL = LOCAL_HOST.test(API_ORIGIN);

export const WRITES_ALLOWED = !__DEV__ || API_IS_LOCAL;
