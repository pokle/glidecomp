#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
# ]
# ///
"""Turn the archive's feature store into tensors, folds and standardisation.

Step 3's input and every later step's (issue #692). It reads the JSONL the
`extract-features.ts` extractor wrote, assembles one row per track, and
produces the two things the modelling needs and must not get wrong:

  * **Feature blocks.** Columns are selected by prefix, so an ablation switches
    a whole block off by name rather than by hand-listing columns.
  * **Comp-grouped folds.** 5-fold cross-validation holding out whole
    COMPETITIONS. A task never straddles the split, and neither does a comp —
    otherwise the model learns the day rather than the flying and the number
    means nothing.

Standardisation is fitted on the training fold ALONE and applied to the held-
out one. A missing value becomes the training mean plus its own indicator
column, never a bare zero: "no CAPE in this dataset" and "no CAPE today" are
different statements and the model has to be able to tell them apart.

Usage:
  uv run experiments/track-placement/build-dataset.py            # summary
  uv run experiments/track-placement/build-dataset.py --arm prospective
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

# Feature blocks, by prefix. `route.` exists only retrospectively: before the
# start there is no course flown, so the prospective arm has no such block
# rather than a zero-filled one. `quality.` is inside each window's namespace
# rather than shared, because its fix count over the WHOLE file is flight
# duration wearing a disguise — and flight duration is most of distance flown.
RETRO_BLOCKS = ("retro.",)
PRO_BLOCKS = ("pro.",)
SHARED_BLOCKS = ("task.", "start.")
WEATHER_ERA5 = ("wx.era5.",)
WEATHER_FORECAST = ("wx.fc.",)


def archive_root() -> Path:
    """The glidecomp-archive checkout, found the way the extractor finds it."""
    env = os.environ.get("GLIDECOMP_ARCHIVE_DIR")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent.parent / "glidecomp-archive"
        if (candidate / "comps").is_dir():
            return candidate.resolve()
    raise SystemExit(
        "Cannot find the glidecomp-archive checkout. "
        "Set GLIDECOMP_ARCHIVE_DIR to it."
    )


def load_store(features_dir: Path) -> pd.DataFrame:
    """Every row of the feature store, flattened into one frame."""
    files = sorted(features_dir.glob("*.jsonl"))
    if not files:
        raise SystemExit(
            f"No feature files in {features_dir}. Run extract-features.ts first."
        )
    records = []
    for path in files:
        with path.open() as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                flat = {
                    "comp": row["comp"],
                    "task_dir": row["task_dir"],
                    "pilot_class": row["pilot_class"],
                    "task_date": row["task_date"],
                    "wing": row["wing"],
                    "track_file": row["track_file"],
                    "pro_available": row["pro_available"],
                    "extractor_version": row["extractor_version"],
                }
                flat.update({f"label.{k}": v for k, v in row["label"].items()})
                flat.update(row["features"])
                records.append(flat)
    frame = pd.DataFrame.from_records(records)
    # One task-class is one field. Every within-task metric groups on this.
    frame["task_key"] = frame["task_dir"]
    versions = sorted(frame["extractor_version"].unique())
    if len(versions) > 1:
        print(
            f"WARNING: the store mixes extractor versions {versions}. "
            "Re-run extract-features.ts --force before trusting a result.",
            file=sys.stderr,
        )
    return frame


def feature_columns(frame: pd.DataFrame, prefixes: tuple[str, ...]) -> list[str]:
    return [c for c in frame.columns if c.startswith(prefixes)]


# The named blocks an ablation can switch off, and the prefix each resolves to
# once the arm has fixed whether the window namespace is `retro.` or `pro.`.
# `route` exists only retrospectively; `wx` is switched by --weather instead.
ABLATABLE_BLOCKS = ("task", "start", "quality", "climb", "glide", "day", "route")


def block_prefix(block: str, arm: str) -> str | None:
    if block in ("task", "start"):
        return f"{block}."
    namespace = "retro." if arm == "retrospective" else "pro."
    if block == "route":
        return "retro.route." if arm == "retrospective" else None
    return f"{namespace}{block}."


def arm_columns(
    frame: pd.DataFrame,
    arm: str,
    weather: str = "all",
    blocks: set[str] | None = None,
) -> list[str]:
    """Columns for one framing of the question.

    `arm` is "retrospective" (the whole flight — the reference number) or
    "prospective" (takeoff to the start crossing — the experiment). `blocks`
    names the feature blocks to keep, for the per-block ablation; None keeps
    every one the arm has.
    """
    wanted = set(ABLATABLE_BLOCKS) if blocks is None else blocks
    prefixes = [
        prefix
        for block in wanted
        if (prefix := block_prefix(block, arm)) is not None
    ]
    if weather in ("all", "era5"):
        prefixes += list(WEATHER_ERA5)
    if weather in ("all", "forecast"):
        prefixes += list(WEATHER_FORECAST)
    return feature_columns(frame, tuple(prefixes))


def arm_rows(frame: pd.DataFrame, arm: str) -> pd.DataFrame:
    """The rows an arm can actually use.

    The prospective arm is defined over pilots who crossed the start; a pilot
    who never did has no prospective sample, and inventing one from an empty
    window would be inventing data.
    """
    return frame if arm == "retrospective" else frame[frame["pro_available"]].copy()


@dataclass
class Fold:
    index: int
    comps: list[str]
    train_rows: np.ndarray
    test_rows: np.ndarray


def make_folds(frame: pd.DataFrame, n_folds: int = 5, seed: int = 0) -> list[Fold]:
    """Hold out whole competitions, with both wings represented in every fold.

    Comps are dealt out largest-first within each wing, always to the fold
    currently holding fewest rows of that wing. Two-thirds of the corpus is
    three comp series, so this is about keeping a fold from being all-Forbes
    (flatlands aerotow HG) more than about exact balance.
    """
    sizes = frame.groupby(["comp", "wing"]).size().reset_index(name="rows")
    buckets: list[dict] = [
        {"comps": [], "rows_by_wing": {}} for _ in range(n_folds)
    ]
    rng = np.random.default_rng(seed)
    for wing in sorted(sizes["wing"].unique()):
        subset = sizes[sizes["wing"] == wing].copy()
        # Deterministic tie-break, then largest first.
        subset["jitter"] = rng.random(len(subset))
        subset = subset.sort_values(["rows", "jitter"], ascending=[False, True])
        for _, row in subset.iterrows():
            target = min(
                buckets, key=lambda b: b["rows_by_wing"].get(wing, 0)
            )
            target["comps"].append(row["comp"])
            target["rows_by_wing"][wing] = (
                target["rows_by_wing"].get(wing, 0) + int(row["rows"])
            )

    folds = []
    for i, bucket in enumerate(buckets):
        held = set(bucket["comps"])
        mask = frame["comp"].isin(held).to_numpy()
        folds.append(
            Fold(
                index=i,
                comps=sorted(held),
                train_rows=np.flatnonzero(~mask),
                test_rows=np.flatnonzero(mask),
            )
        )
    return folds


def standardise(
    train: np.ndarray, test: np.ndarray
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Fit on the training fold alone; missing becomes mean + an indicator.

    Returns the two matrices with the indicator columns appended, and the
    suffix names for them so a caller can label its own columns.
    """
    means = np.nanmean(np.where(np.isfinite(train), train, np.nan), axis=0)
    means = np.where(np.isfinite(means), means, 0.0)
    stds = np.nanstd(np.where(np.isfinite(train), train, np.nan), axis=0)
    stds = np.where(np.isfinite(stds) & (stds > 1e-9), stds, 1.0)

    def apply(matrix: np.ndarray) -> np.ndarray:
        missing = ~np.isfinite(matrix)
        filled = np.where(missing, means, matrix)
        scaled = (filled - means) / stds
        return np.hstack([scaled, missing.astype(np.float64)])

    return apply(train), apply(test), ["__missing"]


def matrix(frame: pd.DataFrame, columns: list[str]) -> np.ndarray:
    return frame[columns].to_numpy(dtype=np.float64, na_value=np.nan)


def usable_columns(frame: pd.DataFrame, columns: list[str]) -> tuple[list[str], list[str]]:
    """Drop columns no row in this arm can answer, and name them.

    A feature that is null everywhere becomes a constant standardised column
    plus a constant indicator column — two dimensions of pure noise. The
    extractor still emits it (a comp that declares a launch window would fill
    it), so the drop belongs here, where it is visible and per-arm.
    """
    values = matrix(frame, columns)
    coverage = np.isfinite(values).mean(axis=0)
    keep = [c for c, cov in zip(columns, coverage) if cov > 0]
    dropped = [c for c, cov in zip(columns, coverage) if cov == 0]
    return keep, dropped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=None, help="archive root")
    parser.add_argument(
        "--arm", choices=["retrospective", "prospective"], default="retrospective"
    )
    parser.add_argument("--folds", type=int, default=5)
    args = parser.parse_args()

    root = args.store or archive_root()
    frame = load_store(root / "features")
    rows = arm_rows(frame, args.arm)
    columns = arm_columns(frame, args.arm)

    print(f"store            {root / 'features'}")
    print(f"arm              {args.arm}")
    print(f"rows             {len(rows)} of {len(frame)}")
    print(f"task-classes     {rows['task_key'].nunique()}")
    print(f"comps            {rows['comp'].nunique()}")
    print(f"features         {len(columns)}")
    by_wing = rows.groupby("wing").size().to_dict()
    print(f"by wing          {by_wing}")
    print(
        "field size       "
        f"median {rows.groupby('task_key')['label.field_size'].first().median():.0f}, "
        f"min {rows['label.field_size'].min()}, max {rows['label.field_size'].max()}"
    )
    columns, dropped = usable_columns(rows, columns)
    if dropped:
        print(f"  dropped (no row answers them): {', '.join(dropped)}")
    covered = matrix(rows, columns)
    complete = np.isfinite(covered).mean(axis=0)
    print(f"column coverage  median {np.median(complete):.3f}, min {complete.min():.3f}")
    thin = [c for c, cov in zip(columns, complete) if cov < 0.5]
    if thin:
        print(f"  under half populated ({len(thin)}): {', '.join(thin[:12])}"
              + (" …" if len(thin) > 12 else ""))

    print("\nfolds (held-out comps)")
    for fold in make_folds(rows, args.folds):
        held = rows[rows["comp"].isin(fold.comps)]
        wings = held.groupby("wing").size().to_dict()
        print(
            f"  fold {fold.index}: {len(fold.test_rows):5d} rows  {wings}  "
            f"{', '.join(fold.comps)}"
        )


if __name__ == "__main__":
    main()
