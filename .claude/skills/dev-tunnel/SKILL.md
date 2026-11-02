---
name: dev-tunnel
description: Expose the local GlideComp dev server (Vite on :3000) at a named Cloudflare Tunnel on <word>.glidecomp.com (word taken from the branch name) so it can be opened from a phone or another device, with sign-in and live reload (HMR) working. Use when asked for a "dev tunnel", to test on a phone/mobile, share the local dev URL, or reach localhost:3000 from another device.
---

# Dev Tunnel

Expose the running GlideComp dev server to a phone or another device at
**`https://<word>.glidecomp.com`**, via a named Cloudflare Tunnel, keeping
Vite's live reload (HMR) working over the public URL.

**Use a named tunnel on a `glidecomp.com` subdomain by default — the owner's
standing preference.** Sign-in works there: auth cookies and trusted origins
cover `*.glidecomp.com`, which a random `*.trycloudflare.com` host does not.
Fall back to a Quick Tunnel (below) only when `~/.cloudflared/cert.pem` is
missing (e.g. a cloud container with no Cloudflare login).

## How it's wired

`bun run dev` starts Vite on **:3000** plus the Workers and Astro. The phone
only needs to reach **Vite** — all `/api/*` and Astro traffic is proxied
**server-side** (`localhost:8790` for the Workers, `localhost:4321` for Astro),
so those ports never need exposing.

Two Vite settings in [`web/frontend/vite.config.ts`](../../../web/frontend/vite.config.ts)
make the tunnel work, both **gated behind the `TUNNEL` env var** so normal
localhost dev is unaffected:

- `allowedHosts: ['.trycloudflare.com', '.glidecomp.com']` — without it Vite
  returns `Blocked request. This host … is not allowed`. The leading dot
  matches every subdomain, so no config change per tunnel name.
- `hmr: { clientPort: 443 }` — the tunnel terminates TLS at :443, so the HMR
  websocket must target that, not the raw dev port, or live reload silently
  fails. This is why it's gated: on plain localhost the client needs the real
  port.

## Pick the subdomain

Take one short, readable word from the current branch name, lowercased:
skip `claude`, random suffixes like `7eon59`, and generic words (`fix`,
`feature`, `update`). Prefer the most distinctive word of 3–10 letters.
`claude/intelligent-clarke-7eon59` → `clarke`. Never pick a name that is a
real production host (`www`, `api`, `app`, `mcp`, `auth`, `mail`, …): check
first with `dig +short <word>.glidecomp.com` — if it resolves and is **not**
already a `cfargotunnel.com` CNAME of ours (`cloudflared tunnel list`), pick
another word.

Name the tunnel `glidecomp-<word>`.

## Run it

```bash
WORD=clarke   # from the branch, per above

# one-time per word (skip each step if it already exists — `cloudflared tunnel list`)
cloudflared tunnel create glidecomp-$WORD
cloudflared tunnel route dns glidecomp-$WORD $WORD.glidecomp.com

# background 1 — dev stack with tunnel mode on
TUNNEL=1 bun run dev

# background 2 — the tunnel to the Vite port
cloudflared tunnel run --url http://localhost:3000 glidecomp-$WORD
```

If a dev server is already listening on :3000 **without** `TUNNEL=1`, it will
block the host — restart it with the flag. `TUNNEL=1` propagates down through
`bun run dev` → the frontend `dev` script → `vite`.

Verify before reporting: poll `curl -s -o /dev/null -w '%{http_code}'
https://$WORD.glidecomp.com/` until 200 (DNS for a new record can take a
minute), and check `/api/auth/me` answers too.

## Show a QR code of the tunnel URL

Finish by sending the URL as a QR code **PNG** (SendUserFile) alongside the
plain URL — utf8 block-character QR codes don't render reliably in this
environment:

```bash
bunx qrcode -o <scratchpad>/dev-tunnel-qr.png -w 400 "https://$WORD.glidecomp.com"
```

## Cleanup

Tunnels and their CNAMEs persist and are reusable on the next run of the same
branch. To remove one: `cloudflared tunnel delete glidecomp-<word>` and delete
the `<word>` CNAME in the Cloudflare dashboard (cloudflared can't remove DNS).

## Quick Tunnel fallback (no Cloudflare login)

```bash
TUNNEL=1 bun run dev
cloudflared tunnel --url http://localhost:3000
```

Prints a random `https://<random>.trycloudflare.com` URL. Needs no account,
but **sign-in won't work** there (the origin is outside `*.glidecomp.com`).

## Notes

- **`cloudflared` must be installed** (`brew install cloudflared`); named
  tunnels also need `cloudflared tunnel login` once (writes `cert.pem`).
- **Simpler LAN alternative** (same Wi-Fi, no tunnel): add `host: true` to the
  Vite `server` block and open `http://<mac-lan-ip>:3000`.
- **If HMR still won't connect** over the tunnel, also set `hmr.protocol: 'wss'`
  alongside `clientPort`.
