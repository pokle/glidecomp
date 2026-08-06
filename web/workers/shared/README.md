# @glidecomp/worker-kit

The few things more than one Worker must agree on.

Not a dumping ground for shared utilities — a worker's own helpers belong in
that worker. What lands here is narrower: a rule where two workers **silently
diverging would be a bug**, and where nothing would fail to tell you.

Today that is two things, both previously copied byte-for-byte between
`auth-api` and `competition-api`:

- **`cors`** — the allowed-origin allowlist. It is a security boundary with
  `credentials: true`, so a domain added to one worker and not the other is a
  real difference in who may make authenticated requests, and no test covers
  the worker that was not edited.
- **`rate-limit`** — the fixed-window counter. Both workers write the SAME
  `rateLimit` table in the SAME D1 database, so they are not two
  implementations of one idea; they are two writers of one storage contract.

The bar for adding a third: would a divergence be a bug, and would anything
catch it? If not, keep it in the worker that owns it.
