# Can one track predict its own placement?

*Written 9 September 2026, with the experiment it reports. The design is
[`experiments/track-placement/PLAN.md`](../experiments/track-placement/PLAN.md)
and the issue is [#692](https://github.com/pokle/glidecomp/issues/692).*

**This is an experiment, not product code.** Nothing in it is imported by the
app, by the engine's scoring closure, or by CI, and nothing here changes a
published score.

GAP is relative by construction: your points depend on what everybody else did
that day. The question was whether a network that sees **one track at a time** —
never the field — can predict where that track will place. Two framings, and
the second is the real one:

- **Retrospective.** The whole flight is visible. How much of placement is
  explained by the flight itself, once the day and the task are known?
- **Prospective.** Everything the pilot's track carries **up to the moment they
  cross the start cylinder**, plus the task and the day's forecast. Nothing
  after the start.

## The answers, up front

| | Prospective | Retrospective |
|---|---|---|
| **Feature MLP, listwise** | **rho 0.45** | rho 0.89 |
| Distance flown alone (one feature, OLS) | not available before the start | **rho 0.92** |
| Made goal + speed-section time | not available before the start | rho 0.70 |
| Pilot's historical mean placement (*analysis only*) | rho 0.31 | rho 0.36 |
| Constant | rho 0.00 | rho 0.00 |

rho is the mean **within-task** Spearman correlation between predicted and
actual placement, over 5-fold cross-validation holding out whole competitions.

Three findings, in the order they matter:

1. **The prospective signal is real and it is about the start.** A model that
   sees only the flight up to the start crossing orders the field at rho 0.45 —
   well clear of knowing nothing (0.00) and clear of knowing exactly who the
   pilot is (0.31). How you arrive at the start line says more about where you
   finish than your competition record does.

2. **Retrospectively, GAP is mostly distance.** The network, with 188 features
   including distance flown, lands at rho 0.89 — *below* an ordinary
   least-squares fit on distance flown alone at rho 0.92. That is not a
   disappointing model; it is the answer. Once the flight is over, placement is
   very nearly a monotone function of how far you got, and the other 187
   features have almost nothing left to add.

3. **The weather forecast earned nothing.** Reported with and without, in both
   arms, the difference is inside the fold-to-fold noise. See "Did the forecast
   earn its keep" below — the answer is no, and the honest reading is that the
   day is already in the track.

## The corpus

Every non-synthetic competition across both checkouts: 27 competitions,
194 task-classes, 5 326 IGC files, 2017–2026, Australian comps — Bright Open
and Unungra (PG), Corryong Cup, Dalby Big Air and Forbes Flatlands (HG).

| | |
|---|---|
| Rows (retrospective) | 4 950 over 191 task-classes |
| Rows (prospective) | 4 724 — the rest never crossed the start |
| Withheld by a HARD `assessTrackQuality` check | 1 |
| Empty IGC files (a registered pilot who never flew) | 367 |
| No takeoff the detectors could find | 5 |
| Median field size | 21 pilots |

Labels come from scoring each task-class with the engine under the same
parameter resolution the seed → scorer path produces. Where the surname joins
uniquely, every row also carries the published AirScore total as a parity
column, and the manifest records per task-class how far the two sit apart *and
how well they agree on the order* — which is the number that matters, because
the label is the order. Median rho between the engine's ordering and
AirScore's is **0.999**; 25 task-classes fall below 0.95 and are named in the
run report. Unungra Cup 2020 is the instructive case: on the unreproducible
GGap formula the engine is 115 points away from the published totals on task 1
and still orders that field at rho 0.996.

## What the model was allowed to see

The whole experiment turns on this, so it is enforced in the extractor rather
than trusted to discipline.

- **No pilot identity as a feature.** A row carries the IGC filename, which is
  what joins it back to a track, and nothing else — no name, no federation id,
  no CIVL ranking, no historical form.
- **No field-derived features.** The extractor builds its own feature set from
  the single-track detectors rather than filtering the engine's `FieldContext`,
  so `gaggle.*`, `climb.shared_percentile`, `glide.ld_vs_field`,
  `race.time_behind` and the whole field-derived `day.*` family cannot leak in.
- **The field appears only in the label.** Field size is on the label side for
  exactly this reason.
- **Truncation happens before the detectors run.** The prospective window is
  `fixes.slice(0, startCrossing + 1)` handed to `detectFlight` and
  `detectCircles` — never a slice of their output, or a detector's own window
  (thermal hysteresis, the circling state machine's delays) could let a
  post-start fix decide something the prospective model must not know.
- **A fallback start is not a start.** The sequence resolver also fills
  `sssReaching` from the first turnpoint or the track start for a pilot who
  never crossed the SSS. Those rows carry no prospective block.

### One leak we found, and what it was worth

The first prospective run put rho at 0.50. The track-quality block — the three
SOFT findings plus the fix count and interval — was being read from the whole
file and shared across both arms. Fix count over a whole flight is flight
duration wearing a disguise, and flight duration is most of distance flown.
Namespacing that block per window, so the prospective arm sees only its own
truncated fixes, moved the headline from 0.50 to **0.45**. Worth 0.05 of rho,
from seven features nobody would call a feature.

## Where the prospective signal lives

Every block trained alone, and the two most interesting left out, prospective
arm, weather off:

| Block kept | Features | rho | Per fold |
|---|---|---|---|
| **`start.` alone** | **11** | **0.452** | +0.48 +0.51 +0.44 +0.52 +0.35 |
| everything | 94 | 0.453 | +0.44 +0.54 +0.46 +0.50 +0.36 |
| everything except `start.` | 83 | 0.372 | +0.32 +0.45 +0.41 +0.39 +0.32 |
| `climb.` alone | 20 | 0.349 | +0.29 +0.44 +0.37 +0.41 +0.28 |
| `day.` alone (the day as this track reports it) | 11 | 0.305 | +0.29 +0.35 +0.34 +0.24 +0.33 |
| `glide.` alone | 14 | 0.292 | +0.33 +0.40 +0.29 +0.32 +0.17 |
| `quality.` alone | 7 | 0.193 | +0.21 +0.12 +0.15 +0.24 +0.21 |
| `task.` alone | 31 | 0.004 | −0.00 +0.03 +0.00 +0.00 +0.00 |

**Eleven features describing the start crossing carry the entire prospective
result.** Everything else — how well the pilot climbed on the way up, how they
glided, what their circles said the wind was doing — is real signal on its own
but adds nothing once the start is in. The start features are: height at the
crossing, height above launch, height below the pilot's own ceiling so far,
seconds after the gate they took, which gate that was and how many were left,
the climb rate over the last ten minutes, distance from the start cylinder's
optimal exit point, how long they had been airborne, and the local clock time.

The `task.` row is the control. Task features are constant within a
task-class, so they cannot order one, and rho 0.004 is the evaluation
confirming it can only be rewarded for ordering. Any other number there would
have meant the metric was broken.

## Did the forecast earn its keep?

No.

| Arm | no weather | ERA5 only | forecast only | both |
|---|---|---|---|---|
| Prospective | 0.453 | 0.434 | 0.434 | 0.446 |
| Retrospective | 0.891 | 0.885 | 0.899 | 0.890 |

The spread across weather arms (0.019 prospective, 0.014 retrospective) is
smaller than the spread across folds within any one of them (0.18 and 0.06).
Both weather datasets are reported anyway, and the archive keeps them, because
"we asked and it did not help" is a different statement from "we did not ask" —
and the fetch is the expensive, rate-limited, perishable part.

The most likely reason is that the day is already in the track. `day.*` — the
wind the pilot's own circles measured, the ceiling they reached, how their
climb rate trended — is a 25 km ERA5 cell's worth of weather measured by an
instrument that was actually there.

## Listwise beats pointwise

| Arm | listwise (ListNet) | pointwise (regression + top-decile head) |
|---|---|---|
| Prospective | **0.446** | 0.376 |
| Retrospective | **0.890** | 0.863 |

Training the model to order a field it cannot see beats training it to predict
a percentile and reading the order off afterwards, in both arms. The honest
formulation of the question is also the better-performing one.

## The fold spread is part of the finding

Two-thirds of the corpus is three competition series, so a fold holding out
Forbes is holding out flatlands aerotow hang gliding. In the weather-off run that
is the block table's "everything" row, prospective rho runs +0.36 to +0.54
across the five folds — a spread of 0.18 on a pooled 0.45.
Every table above prints per-fold numbers for that reason, and any single
pooled figure from this corpus should be read with that spread attached.

## Reading P@k and AUC

Precision@3 and @10 count every task-class with at least *k* pilots, and the
small floater classes give them a high chance floor — a constant predictor
scores P@3 0.32. Read them against the constant row, which *is* that floor,
not against zero.

MAE and AUC are computed on the prediction re-expressed as a within-task
percentile. A listwise model's scores carry no scale, so comparing them to a
percentile label directly would report an artefact of the loss. rho and P@k
are invariant to that transform; only MAE and AUC change, and the raw figures
stay in the results JSON.

One nice detail falls out of it: "made goal + speed-section time" has a *lower*
rho than "distance flown alone" (0.70 against 0.92) but a much higher P@3
(0.83 against 0.57) and AUC (0.945 against 0.909). Knowing who made goal
separates the top of the field perfectly and then leaves them tied with each
other; distance orders everybody moderately well and nobody exactly.

## What this does not answer

- **The sequence branch was not built.** The plan's step 6 — the track
  resampled to 256 steps × ~8 channels through a small 1D CNN, reported as a
  delta on the engineered features — needs a resampled-track output the feature
  store does not carry yet. Whether the raw track holds something the features
  flatten is still open.
- **Why the retrospective network trails the one-feature baseline** is
  consistent with "there is nothing left to find", but this experiment did not
  separate that from "4 000 training rows is not enough to find it". Four
  architectures were tried (hidden 64–256, dropout 0.1–0.3, chosen on an inner
  validation split of held-out training competitions); prospective rho moved
  between 0.42 and 0.45 and retrospective between 0.88 and 0.89. The
  architecture is not the constraint within that range.
- **The prospective arm is conditioned on starting.** 226 rows are pilots who
  never crossed the start; they are in the retrospective dataset and not the
  prospective one. "Will this pilot place well" and "will this pilot who has
  just started place well" are different questions, and this answers the second.
- **Correlation, and Australian.** 27 competitions from five series in one
  country. Nothing here says a start height *causes* a placement, and nothing
  says the number transfers to Alpine or Brazilian flying.

## Reproducing it

Everything is in
[`experiments/track-placement/`](../experiments/track-placement/README.md),
which carries the end-to-end instructions. The derived data — about 4 MB of
weather and 47 MB of feature rows (3.2 MB and 0.2 MB once git has packed them) — is committed to
[pokle/glidecomp-archive](https://github.com/pokle/glidecomp-archive) beside
the tracks it comes from, so a rerun starts from a warm, identical corpus with
no network at all.

```bash
bun experiments/track-placement/fetch-weather.ts      # resumable, rate-limit aware
bun experiments/track-placement/extract-features.ts   # ~4 min over 5 300 tracks
uv run experiments/track-placement/baselines.py --arm retrospective
uv run experiments/track-placement/train.py  --arm prospective --loss listwise
```
