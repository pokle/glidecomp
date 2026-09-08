#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
# ]
# ///
"""The four baselines the network has to beat (issue #692, step 3).

Run BEFORE any network. If baseline 4 says placement is nearly all pilot
identity, that reframes the rest of the experiment and gets said out loud
rather than discovered afterwards.

  1. **Constant** — predicts the mean. rho = 0 by construction; it is here to
     prove the evaluation is not accidentally rewarding a flat prediction.
  2. **Distance flown alone** — one feature, ordinary least squares. If the
     retrospective network does not clearly beat this, the retrospective
     answer is "GAP is mostly distance", which is worth saying plainly.
  3. **Made goal + time** — the two-feature scorer's-eye view.
  4. **Pilot's historical mean placement** — *analysis only, never a model
     input*. Computed leave-one-comp-out, from the pilot id in the IGC
     filename, in THIS script and never in the feature store. It is not a
     competitor: it answers "how much of placement is just who the pilot is",
     which is what says whether a track-only model is being asked to do
     something possible.

Baselines 2 and 3 are retrospective by nature — before the start there is no
distance flown and no goal — so the prospective arm reports 1 and 4 only, and
the network's prospective number is read against those.

Usage:
  uv run experiments/track-placement/baselines.py
  uv run experiments/track-placement/baselines.py --arm prospective
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd


def _load_sibling(name: str):
    """Import a hyphenated sibling script as a module.

    Registered in `sys.modules` before it executes: a `@dataclass` in the
    loaded module looks its own module up by name while decorating, and finds
    nothing if the registration comes after.
    """
    path = Path(__file__).with_name(name)
    module_name = path.stem.replace("-", "_")
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


dataset = _load_sibling("build-dataset.py")
report = _load_sibling("report.py")


# "wisewould_18239_050126.igc" → "18239". The federation id in the filename is
# the ONLY place pilot identity exists in this experiment, it is read here and
# nowhere else, and it feeds an analysis number rather than any model.
PILOT_ID = re.compile(r"^(?P<surname>.+)_(?P<id>\d+)_\d{6}\.igc$", re.IGNORECASE)


def pilot_key(track_file: str) -> str:
    match = PILOT_ID.match(track_file)
    if not match:
        return track_file.lower()
    ident = match.group("id")
    # id 0 is AirScore's "no federation id" — those pilots are not one person,
    # so they fall back to their surname rather than merging into a single
    # phantom with hundreds of flights.
    return ident if ident != "0" else match.group("surname").lower()


def ols(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Least-squares coefficients for [x | 1], missing values mean-filled."""
    means = np.nanmean(np.where(np.isfinite(x), x, np.nan), axis=0)
    means = np.where(np.isfinite(means), means, 0.0)
    filled = np.where(np.isfinite(x), x, means)
    design = np.hstack([filled, np.ones((len(filled), 1))])
    coeffs, *_ = np.linalg.lstsq(design, y, rcond=None)
    return coeffs


def predict(coeffs: np.ndarray, x: np.ndarray, train_means: np.ndarray) -> np.ndarray:
    filled = np.where(np.isfinite(x), x, train_means)
    return np.hstack([filled, np.ones((len(filled), 1))]) @ coeffs


def linear_baseline(
    frame: pd.DataFrame, folds, columns: list[str]
) -> tuple[pd.DataFrame, list[dict]]:
    """OLS on `columns`, fitted per fold on the training comps only."""
    predictions = np.full(len(frame), np.nan)
    values = frame[columns].to_numpy(dtype=np.float64, na_value=np.nan)
    target = frame["label.percentile"].to_numpy(dtype=np.float64)
    for fold in folds:
        train_x = values[fold.train_rows]
        means = np.nanmean(np.where(np.isfinite(train_x), train_x, np.nan), axis=0)
        means = np.where(np.isfinite(means), means, 0.0)
        coeffs = ols(train_x, target[fold.train_rows])
        predictions[fold.test_rows] = predict(coeffs, values[fold.test_rows], means)
    return _scored(frame, predictions, folds)


def constant_baseline(frame: pd.DataFrame, folds):
    predictions = np.full(len(frame), np.nan)
    target = frame["label.percentile"].to_numpy(dtype=np.float64)
    for fold in folds:
        predictions[fold.test_rows] = target[fold.train_rows].mean()
    return _scored(frame, predictions, folds)


def pilot_history_baseline(frame: pd.DataFrame, folds):
    """Each pilot's mean placement over the comps they are not being tested on.

    Leave-one-COMP-out, matching the fold structure: a pilot's history must
    never include the competition they are being predicted in, or the number
    is a memory rather than a prior.
    """
    work = frame.copy()
    work["pilot"] = work["track_file"].map(pilot_key)
    predictions = np.full(len(work), np.nan)
    percentile = work["label.percentile"].to_numpy(dtype=np.float64)
    pilots = work["pilot"].to_numpy()
    comps = work["comp"].to_numpy()

    for fold in folds:
        held = set(comps[fold.test_rows])
        train_mask = ~np.isin(comps, list(held))
        history: dict[str, list[float]] = {}
        for pilot, value in zip(pilots[train_mask], percentile[train_mask]):
            history.setdefault(pilot, []).append(value)
        prior = float(percentile[train_mask].mean())
        means = {p: float(np.mean(v)) for p, v in history.items()}
        # A pilot the training comps never saw gets the field mean, which is
        # exactly "we know nothing about them" — the honest prediction.
        predictions[fold.test_rows] = [
            means.get(p, prior) for p in pilots[fold.test_rows]
        ]
    return _scored(work, predictions, folds)


def _scored(frame: pd.DataFrame, predictions: np.ndarray, folds):
    scored = pd.DataFrame(
        {
            "task_key": frame["task_key"].to_numpy(),
            "comp": frame["comp"].to_numpy(),
            "pred": predictions,
            "actual": frame["label.percentile"].to_numpy(dtype=np.float64),
            "top_quartile": frame["label.top_quartile"].to_numpy(dtype=np.float64),
        }
    ).reset_index(drop=True)
    per_fold = [
        report.evaluate(scored.iloc[fold.test_rows].reset_index(drop=True))
        for fold in folds
    ]
    return scored, per_fold


def coverage_note(frame: pd.DataFrame, columns: list[str]) -> str:
    have = np.isfinite(frame[columns].to_numpy(dtype=np.float64, na_value=np.nan))
    return f"{have.all(axis=1).mean():.1%} of rows carry every input"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=None)
    parser.add_argument(
        "--arm", choices=["retrospective", "prospective"], default="retrospective"
    )
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--out", type=Path, default=None, help="write results JSON")
    args = parser.parse_args()

    root = args.store or dataset.archive_root()
    frame = dataset.load_store(root / "features")
    rows = dataset.arm_rows(frame, args.arm).reset_index(drop=True)
    folds = dataset.make_folds(rows, args.folds)

    specs = [("Constant (field mean)", lambda: constant_baseline(rows, folds))]
    if args.arm == "retrospective":
        specs.append(
            (
                "Distance flown alone",
                lambda: linear_baseline(rows, folds, ["retro.route.flown_m"]),
            )
        )
        specs.append(
            (
                "Made goal + speed-section time",
                lambda: linear_baseline(
                    rows,
                    folds,
                    ["retro.route.made_goal", "retro.route.speed_section_s"],
                ),
            )
        )
    specs.append(
        ("Pilot history (ANALYSIS ONLY)", lambda: pilot_history_baseline(rows, folds))
    )

    models = []
    for name, build in specs:
        scored, per_fold = build()
        models.append(
            {
                "name": name,
                "folds": per_fold,
                "pooled": report.evaluate(scored),
            }
        )

    results = {
        "title": "Baselines",
        "arm": args.arm,
        "rows": int(len(rows)),
        "tasks": int(rows["task_key"].nunique()),
        "comps": int(rows["comp"].nunique()),
        "folds": [{"index": f.index, "comps": f.comps} for f in folds],
        "models": models,
    }
    report.print_table(results)
    print(
        "\n  'Pilot history' is NOT a competitor and is never a model input: it is "
        "how much\n  of placement is just who the pilot is, computed "
        "leave-one-comp-out from the\n  federation id in the IGC filename."
    )
    if args.out:
        args.out.write_text(json.dumps(results, indent=2) + "\n")
        print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
