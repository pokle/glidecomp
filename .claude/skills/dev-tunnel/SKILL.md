---
name: dev-tunnel
description: Expose the local GlideComp dev server (Vite on :3000) over a public Cloudflare Quick Tunnel so it can be opened from a phone or another device, with live reload (HMR) working over the tunnel. Use when asked for a "dev tunnel", to test on a phone/mobile, share the local dev URL, or reach localhost:3000 from another device.
---

# Dev Tunnel

Expose the running GlideComp dev server to a phone or another device via a
Cloudflare Quick Tunnel (`cloudflared tunnel --url`), keeping Vite's live
reload (HMR) working over the public URL.

## How it's wired

`bun run dev` starts Vite on **:3000** plus the Workers and Astro. The phone
only needs to reach **Vite** — all `/api/*` and Astro traffic is proxied
**server-side** (`localhost:8788/8789/4321`), so those ports never need
exposing.

Two Vite settings in [`web/frontend/vite.config.ts`](../../../web/frontend/vite.config.ts)
make the tunnel work, both **gated behind the `TUNNEL` env var** so normal
localhost dev is unaffected:

- `allowedHosts: ['.trycloudflare.com']` — the leading dot matches the random
  `*.trycloudflare.com` hostname cloudflared assigns each run. Without it Vite
  returns `Blocked request. This host … is not allowed`.
- `hmr: { clientPort: 443 }` — the tunnel terminates TLS at :443, so the HMR
  websocket must target that, not the raw dev port, or live reload silently
  fails. This is why it's gated: on plain localhost the client needs the real
  port, so setting 443 unconditionally would break local HMR.

## Run it

Two terminals:

```bash
# terminal 1 — dev stack with tunnel mode on
TUNNEL=1 bun run dev

# terminal 2 — public tunnel to the Vite port
cloudflared tunnel --url http://localhost:3000
```

`TUNNEL=1` propagates down through `bun run dev` → the frontend `dev` script →
`vite`, so `process.env.TUNNEL` is set when the config evaluates.

cloudflared prints a `https://<random>.trycloudflare.com` URL — open it on the
phone. Edits hot-reload over the tunnel.

## Show a QR code of the tunnel URL

Always finish by displaying the tunnel URL as a QR code in the chat so it can
be scanned straight off the screen with the phone camera:

```bash
bunx qrcode -t utf8 -o <scratchpad>/dev-tunnel-qr.txt 'https://<random>.trycloudflare.com'
```

Then Read the file and paste its contents into the reply inside a fenced code
block, alongside the plain URL.

- The `utf8` renderer emits plain `▀▄█` half-block characters, which render
  correctly in a markdown code block. Do **not** use the default terminal
  renderer (`bunx qrcode '<url>'` with no `-t`) — it emits ANSI color escapes
  that don't render in chat output. `-t utf8` requires `-o <file>`.
- On dark terminal themes the code appears inverted (light on dark); phone
  cameras usually scan it anyway. Add `-i` to flip colors if scanning fails.

## Notes

- **`cloudflared` must be installed** (`brew install cloudflared`). Quick
  Tunnels need no Cloudflare account or login.
- **A random hostname each run** is expected; `.trycloudflare.com` in
  `allowedHosts` covers all of them, so no config change between runs.
- **Auth cookies are per-origin.** A session on `localhost:3000` does not carry
  to the tunnel host — sign in fresh there (dev-login sets its cookie on the
  tunnel origin, so it works, just separately).
- **Simpler LAN alternative** (same Wi-Fi, no tunnel): add `host: true` to the
  Vite `server` block and open `http://<mac-lan-ip>:3000`. Hitting it by IP
  needs no `allowedHosts` entry. Prefer this when both devices are on the same
  network; use the tunnel for locked-down/guest Wi-Fi or sharing externally.
- **If HMR still won't connect** over the tunnel, also set `hmr.protocol: 'wss'`
  alongside `clientPort`. `clientPort: 443` alone is usually enough because Vite
  infers the protocol from the page's `https:` origin.
