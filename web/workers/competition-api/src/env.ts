export type Env = {
  DB: D1Database;
  AUTH_API: Fetcher;
  SQIDS_ALPHABET: string;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
};
