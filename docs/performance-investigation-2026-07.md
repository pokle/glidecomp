# Performance investigation: scoring & 3D-replay packing (July 2026)

Where do the "up to 20 second" delays on scoring and 3D-replay endpoints come
from, and which Cloudflare infrastructure options (if any) would fix them?

**TL;DR: the bottleneck is storage round trips, not JavaScript.** Pure compute
for the largest bundled task is ~0.35 s (scoring) / ~0.5 s (packing). The same
cold endpoints served by workerd with local disk-backed D1/R2/KV finish in
0.6–0.9 s. In production the same cold 3dvis request takes 7.7–8.6 s — the
difference is almost entirely R2/D1/KV round-trip latency, amplified by
sequential access patterns. Moving compute to Cloudflare Containers (or VMs)
would not help; keeping data-adjacent round trips low does.

## Methodology

Three measurement layers, biggest sample task first
(`corryong-cup-2026-open-t1..t3`, 33–38 tracks, ~10 MB raw IGC, ~287 k fixes):

1. **Pure engine compute** — `bun web/engine/cli/bench-task.ts <task-dir>`
   times gunzip → parseIGC → resolveTurnpointSequence → scoreFlights and
   gunzip → packTracksFromIgc → gzip with all files local. Run under both Bun
   (JSC) and Node 22 (V8, same engine family as workerd).
2. **Local workerd** — `bun run dev:workers` + `bun run seed:sample`, then
   time `GET /task/:id/score` and `/task/:id/3dvis` cold (fresh KV) and warm.
   Local D1/R2/KV are on disk, so this isolates compute + framework overhead
   in the real Workers runtime with storage latency ≈ 0.
3. **Production** — timed `glidecomp.com` endpoints for the seeded sample
   comp from a US client (Cloudflare colo IAD), catching four natural
   KV-expired cache misses on 3dvis.

## Results

### Pure compute (largest task, 33–38 tracks)

| Stage | Bun | Node 22 (V8) |
|---|---|---|
| gunzip all tracks | 41 ms | 40 ms |
| parseIGC all tracks | 237 ms | 199 ms |
| resolveTurnpointSequence all tracks | 64 ms | 95 ms |
| GAP scoreFlights | 4 ms | 4 ms |
| **Scoring total** | **346 ms** | **340 ms** |
| packTracksFromIgc (parse+score+pack) | 347 ms | 321 ms |
| gzip 4.6 MB vertex data | 107 ms | 114 ms |
| **3dvis total** | **490 ms** | **479 ms** |

Leading-points scan adds ~32 ms. The open-distance path (big-chip, 50 tracks)
totals ~46 ms. Compute scales linearly with fix count; even a 150-pilot task
with these track lengths extrapolates to ~1.5–2 s of CPU.

### Endpoint latency, same code and data

| Request (largest task) | Local workerd | Production |
|---|---|---|
| score, cold (cache MISS) | 0.87 s | not caught (all warm) |
| 3dvis, cold (cache MISS) | 0.65 s | **7.7–8.6 s** |
| 3dvis, cold, small task (21 tracks) | 0.08 s | 3.7 s |
| score, warm (KV HIT) | 0.017 s | 1.3–1.6 s |
| 3dvis, warm (KV HIT) | 0.022 s | 1.6–2.1 s |
| trivial endpoint (`GET /api/comp`) | — | 0.53–0.55 s |

Production measurements from a US client at colo IAD; ~0.2 s of the warm
numbers is TLS setup, and the 3dvis HIT includes downloading a 3 MB bundle.

## Bottleneck analysis

- **Cold 3dvis (was 20 s-class): sequential R2 GETs.** The build loop fetched
  each track one at a time — ~35 tracks × ~150–200 ms per GET from the worker
  to the bucket ≈ 6–7 s of pure round-trip waiting, on ~0.5 s of actual
  compute. (The scoring path already fetched with concurrency 10, which is
  why cold scoring is far less painful.) **Fixed in this branch** by fetching
  with the same bounded concurrency; peak memory is unchanged because the
  pack step already holds every decompressed track simultaneously.
- **Warm requests still cost >1 s far from the D1 primary.** Even a KV HIT
  runs 4 sequential D1 queries first (comp check → task check → 2 cache-key
  queries). From a US edge with the D1 primary in Oceania that's 4 × ~250 ms
  before the cached blob is even looked up. The trivial one-query endpoint
  costing ~0.33 s server-side confirms the per-query round trip.
- **JavaScript is a rounding error.** V8 ≈ Bun ≈ workerd on this workload;
  nothing here is close to CPU limits. Note: the cold scoring path burns
  ~350 ms CPU, which already exceeds the Workers **free**-plan 10 ms CPU
  budget — if scoring works in production today the account is effectively
  relying on paid-plan limits (30 s default, raisable to 5 min via
  `limits.cpu_ms`).

## Cloudflare options evaluated

(Sources: developers.cloudflare.com, checked July 2026.)

- **Containers** — GA since April 2026, requires Workers Paid, instances up
  to 4 vCPU / 12 GiB, attached to Durable Objects, 1–3 s cold starts after
  `sleepAfter`. Verdict: **not the right tool here.** Containers help when
  you need >128 MB memory, multi-core parallelism, or >5 min CPU. This
  workload needs ~0.5 s CPU and its latency is storage round trips, which a
  container makes *worse* (extra hop, cold starts, and it still reads R2/D1
  over the network).
- **Workers Paid limits** — $5/mo raises CPU to 30 s/request (up to 5 min via
  `limits.cpu_ms`), 30 M CPU-ms/mo included. Verdict: **the cheap safety
  net**; removes any risk of CPU-kill on big tasks. Set an explicit
  `[limits] cpu_ms` in `competition-api/wrangler.toml` once on paid.
- **Smart Placement** (free) — runs the Worker near its backend instead of
  near the client. With D1/R2 in one region and many sequential
  storage round trips per request, this converts N × long-haul RTTs into
  N × intra-region RTTs plus one long client RTT. Verdict: **likely the
  single biggest win for far-away users**; enable on competition-api
  (`[placement] mode = "smart"`) and measure.
- **D1 read replication (Sessions API)** — free, beta; replicas in 6 regions.
  Alternative/complement to Smart Placement for the read-heavy paths.
- **Cache API / edge caching of responses** — score JSON and 3dvis bundles
  are content-addressed by KV key, so warm responses could also be cached
  per-colo via the Cache API (needs the custom domain, which we have) or
  longer `Cache-Control`, taking warm latency from ~1.5 s toward ~50 ms for
  repeat viewers. KV remains the source of truth.
- **Queues / Workflows / cron precompute** — free tiers exist (Queues 10 k
  ops/day). Precomputing scores + bundles on track upload (or via
  `waitUntil` after upload) would make user-facing cache misses rare instead
  of fast.
- **Moving to VMs / off Workers** — would add servers to run, cold paths
  would still fetch from R2/D1 over the network, and nothing in the profile
  needs big CPU. Verdict: **no**.

## Recommended order

1. ~~Parallelize 3dvis R2 fetches~~ — done in this branch (expected: cold
   3dvis ~8 s → ~2–3 s in production).
2. ~~Enable Smart Placement on competition-api~~ — done in this branch
   (`[placement] mode = "smart"`). Smart Placement learns from live traffic,
   so measure warm + cold latency from a far-away region a while after the
   merge deploys it, and compare against the numbers above.
3. Precompute score + 3dvis caches at upload time (waitUntil or a queue), so
   users almost never see a cold path.
4. If/when on Workers Paid, set `limits.cpu_ms` explicitly for headroom on
   very large tasks.
5. Optionally collapse the warm path's 4 sequential D1 queries (single joined
   query for comp+task+cache-key state) and add Cache API in front of warm
   responses.
