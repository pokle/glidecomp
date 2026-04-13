export type Env = {
  COMPETITION_API: Fetcher;
  AUTH_API: Fetcher;
};

export type AuthUser = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
};
