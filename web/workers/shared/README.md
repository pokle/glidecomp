# @glidecomp/worker-kit

The few things more than one Worker must agree on.

Not a dumping ground for shared utilities — a worker's own helpers belong in
that worker. What lands here is narrower: a rule where two workers **silently
diverging would be a bug**, and where nothing would fail to tell you.

Today that is three things, the first two previously copied byte-for-byte
between `auth-api` and `competition-api`:

- **`cors`** — the allowed-origin allowlist. It is a security boundary with
  `credentials: true`, so a domain added to one worker and not the other is a
  real difference in who may make authenticated requests, and no test covers
  the worker that was not edited.
- **`rate-limit`** — the fixed-window counter. Both workers write the SAME
  `rateLimit` table in the SAME D1 database, so they are not two
  implementations of one idea; they are two writers of one storage contract.

- **`session-cookie`** — verifying auth-api's signed `session_data` cookie
  with its public key, so a signed-in request needs no auth hop. Two callers
  (competition-api's auth middleware and the SSR Pages Function) must refuse
  exactly the same cookies; one quietly accepting what the other refuses is a
  security difference nothing would catch. See `docs/auth.md`.

The bar for adding a fourth: would a divergence be a bug, and would anything
catch it? If not, keep it in the worker that owns it.
