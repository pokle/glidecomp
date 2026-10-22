# Can one track predict its own placement?

An experiment, not product code. Nothing here is imported by the app, the
engine's scoring closure, or CI. [PLAN.md](PLAN.md) is the design and the
reasoning; this file is how to run it.

GAP is relative by construction: your points depend on what everybody else did
that day. The question is whether a network that sees **one track at a time** —
never the field — can predict where that track will place. The prospective
framing is the real one: everything the pilot's track carries **up to the
moment they cross the start cylinder**, and nothing after it.

## Two checkouts

The corpus spans two repositories, side by side:

```
~/dev/glidecomp/            this repo — 2 comps under web/samples/comps
~/dev/glidecomp-archive/    the back-catalogue — 25 comps under comps/,
                            and where weather/ and features/ are written
```

`extract-features.ts` finds the archive as a sibling of the checkout, walking
up so a run from inside a git worktree still lands on the archive beside the
main checkout. Two environment variables override that:

| Variable | Default | What it points at |
|---|---|---|
| `GLIDECOMP_COMPS_DIR` | `web/samples/comps` | this repo's bundled comps |
| `GLIDECOMP_ARCHIVE_DIR` | `../glidecomp-archive` | the archive checkout, read for comps and written for `features/` |

## Step 1 — features and labels

```bash
bun experiments/track-placement/extract-features.ts
```

Reads every non-synthetic competition in both checkouts, scores each
task-class with the engine, and writes one JSONL row per track into
`<archive>/features/<task-dir>.jsonl` alongside a `manifest.json`.

It is **resumable**: a task folder whose `.jsonl` already exists is left alone.
Pass `--force` to redo it, `--comp <slug>` (repeatable) to restrict the run,
`--out <dir>` to write somewhere other than the archive, and `--stats-only` to
print the dataset report without writing anything.

```bash
# one comp, into a scratch store
bun experiments/track-placement/extract-features.ts \
  --comp bright-open-2024 --out /tmp/store

# re-extract everything after a feature change
bun experiments/track-placement/extract-features.ts --force
```

### What ends up in a row

```jsonc
{
  "schema": 1, "extractor_version": 1,
  "comp": "bright-open-2024", "task_dir": "bright-open-2024-open-t1",
  "pilot_class": "open", "task_date": "2024-02-10", "wing": "pg",
  "track_file": "voegeli_225212_100224.igc",   // the ONLY pilot identity here
  "pro_available": true,
  "label": { "total_score": …, "rank": …, "percentile": …,
             "top_decile": …, "top_quartile": …, "made_goal": …,
             "field_size": …, "airscore_total": … },
  "features": { "task.optimised_m": …, "retro.climb.rate_p75_mps": …, … }
}
```

Feature names are prefixed by block, so the ablation can switch whole blocks
off by prefix:

| Prefix | What it reads |
|---|---|
| `task.` | the `.xctsk` and the resolved GAP parameters — known before anybody launches |
| `quality.` | the three SOFT `assessTrackQuality` findings and the fix interval, as covariates |
| `start.` | the start-cylinder crossing itself: height, gate, the climb into it |
| `wx.era5.` | ERA5 reanalysis over the task window — the whole 2017–2026 corpus |
| `wx.fc.` | the archived operational forecast — 2022+, and the only source of pressure-level winds and CAPE. The ablation arm |
| `retro.climb/glide/day/route.` | the whole flight |
| `pro.climb/glide/day.` | takeoff → the start crossing, and not one fix later |

`route.*` has no prospective counterpart: before the start there is no course
flown, so the block is empty rather than zero-filled. `day.*` under `retro.`
and `pro.` means the day as this pilot's OWN circles report it — their wind
estimates, their ceiling, their climb trend — which is a different quantity
from the engine's field-derived `day.*` family that happens to share a word.

A weather variable a dataset does not carry is null AND flagged by its own
`wx.<dataset>.has_<variable>` indicator, never a zero: ERA5 legitimately has
no CAPE, and a model reading 0 J/kg there has been told something false.
`extract-features.ts` refuses a stored weather answer whose `weatherQueryKey`
is not the one the engine derives for the task today, so a task whose route or
times moved reports its weather as unavailable until it is refetched.

### The rules this script exists to keep

- **No pilot identity as a feature.** A row carries the IGC filename, which is
  what joins it back to a track, and nothing else — no name, no federation id,
  no ranking, no historical form.
- **No field-derived features.** Every number comes from one IGC file, the
  task, and (from `fetch-weather.ts`) a forecast. `lib/track-features.ts` does
  not touch the engine's `FieldContext`, so `gaggle.*`,
  `climb.shared_percentile`, `glide.ld_vs_field`, `race.time_behind` and the
  whole `day.*` family cannot leak in. The `day.*` prefix HERE means the day as
  one pilot's own circles report it, which is a different quantity that happens
  to share a word.
- **The field appears only in the label.** `label.field_size` is on the label
  side for exactly this reason.
- **Truncation happens before the detectors run.** The prospective window is
  `fixes.slice(0, startCrossing + 1)` handed to `detectFlight` /
  `detectCircles`, never a slice of their output — otherwise a detector's own
  window (thermal hysteresis, the circling state machine's delays) could let a
  post-start fix decide something the prospective model is not allowed to know.
- **A fallback start is not a start.** `resolveTurnpointSequence` also fills
  `sssReaching` from the first turnpoint or the track start for a pilot who
  never crossed the SSS. Those rows get `pro_available: false` and no `pro.*`
  block.

### What it drops, and says it dropped

- Tracks a **HARD** `assessTrackQuality` check withholds. A broken logger is
  not a bad flight, so they are dropped from the dataset rather than seated at
  0 — and counted, per comp, in the run report and the manifest.
- **Stopped tasks.** Scored without their stop context the totals are wrong,
  and a wrong label trains a wrong model. `verify-airscore-parity.ts` declines
  to verify these for the same reason.
- Empty IGC files (a registered pilot who never flew), and tracks the
  detectors find no takeoff in.

### The AirScore parity column

Where the surname joins uniquely on both sides, each row carries the published
AirScore total (`airscore-result-raw.json`, `row[16]`) beside the engine's, and
the manifest carries per-task-class the mean and max |Δpoints| **and the
Spearman ρ between the two orderings**. The ρ is the one that matters here: a
comp on a formula the engine cannot reproduce (GGap, `Lkm` departure) can sit
100 points away and still order the field almost identically — and the label
is the order. Unungra Cup 2020 is exactly that case, and the run report names
every task-class below ρ 0.95 so it can be looked at rather than trained on
unseen.

## Step 2 — weather

```bash
bun experiments/track-placement/fetch-weather.ts
```

Derives each task's query with the engine's own `weatherQueryForTask` and
fetches BOTH datasets through the engine's providers, into
`<archive>/weather/<task-dir>/{era5,archived-forecast}.json`. Each file records
the `weatherQueryKey` it answers.

Resumable, and it never refetches what the store already holds — which is what
makes running it past the forecast host's rate limit a matter of leaving it
going. `--provider era5` or `--provider archived-forecast` runs one dataset,
`--comp <slug>` restricts the run, `--delay <ms>` slows it down. A daily-quota
answer stops that dataset cleanly rather than retrying into the wall; whatever
is already stored is kept.

Re-run `extract-features.ts --force` after the weather lands: the `wx.*` block
is read from the store at extraction time.

## Steps 3–5 — baselines and the model

Python is `uv run` with PEP 723 inline dependencies, per the project rule — no
`requirements.txt`, nothing installed into the environment.

```bash
uv run experiments/track-placement/build-dataset.py --arm prospective
uv run experiments/track-placement/baselines.py --arm retrospective
uv run experiments/track-placement/train.py --arm prospective --loss listwise
```

- **`build-dataset.py`** — the store as tensors, plus the fold structure and
  the standardisation. Folds hold out whole COMPETITIONS: a task never
  straddles the split and neither does a comp, or the model learns the day
  rather than the flying. Standardisation is fitted on the training fold
  alone, and a missing value becomes the training mean plus its own indicator
  column, never a bare zero. Run it on its own to print the dataset summary
  and the fold composition.
- **`baselines.py`** — the four baselines from the plan. Run before any
  network: if the pilot-history number says placement is nearly all identity,
  that reframes everything after it. Baselines 2 and 3 (distance flown; made
  goal + time) are retrospective by nature, so the prospective arm reports 1
  and 4 only.
- **`train.py`** — the feature MLP. `--loss listwise` is the headline (a
  ListNet softmax over one task-class, so the model is trained to order a
  field it cannot see); `--loss pointwise` is the calibration comparison.
  `--weather none|era5|forecast|all` is the forecast ablation.
- **`report.py`** — the metric vocabulary, shared by the baselines and the
  network so a headline number can never move because two scripts disagreed
  about how to average a within-task correlation. Run it on a results JSON to
  re-print the table.

Pilot identity appears in exactly one place in the Python: `baselines.py`
reads the federation id out of the IGC filename for the analysis-only
history baseline. Nothing else touches it, and no model gets it.

## Steps 6–8

Not built. The sequence branch (the track resampled to 256 × ~8 channels
through a small 1D CNN), the remaining per-block ablations, and the write-up
follow the sequence in [PLAN.md](PLAN.md#sequence-of-work). The sequence
branch needs a resampled-track output the feature store does not yet carry.

## Why the TypeScript lives here

Outside `web/engine/src/`, so the scoring fingerprint and its change-note
check are untouched; and outside every `tsconfig.json` `include`, so
`typecheck:all` is unaffected. It imports `@glidecomp/engine` like any other
script in the repo.
