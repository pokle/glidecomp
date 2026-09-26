#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
# ]
# ///
"""Metrics and result tables for the track-placement experiment (issue #692).

The evaluation vocabulary lives here so the baselines and the network are
scored by the identical code — a headline number that moved because two
scripts disagreed about how to average a within-task correlation would be
worse than no number.

The headline is **Spearman rho between predicted and actual placement,
computed WITHIN each task and then averaged**. That is exactly "did it get the
order right", and it is immune to the model being globally miscalibrated. A
pooled correlation over all 4 900 rows would instead reward a model that has
merely learnt which DAYS score highly, which is not the question.

Everything is reported per fold as well as pooled: two-thirds of the corpus is
three comp series, so a fold holding out Forbes is holding out flatlands
aerotow hang gliding, and the spread across folds is part of the finding.

Usage:
  uv run experiments/track-placement/report.py results.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd


def _rank(values: np.ndarray) -> np.ndarray:
    """1-based ranks, ties sharing their average rank."""
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=np.float64)
    ranks[order] = np.arange(1, len(values) + 1, dtype=np.float64)
    # Average the ranks of tied runs.
    sorted_values = values[order]
    i = 0
    while i < len(sorted_values):
        j = i
        while j + 1 < len(sorted_values) and sorted_values[j + 1] == sorted_values[i]:
            j += 1
        if j > i:
            ranks[order[i : j + 1]] = ranks[order[i : j + 1]].mean()
        i = j + 1
    return ranks


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    """Spearman rho, NaN when either side has no spread to correlate."""
    if len(a) < 3:
        return float("nan")
    ra, rb = _rank(a), _rank(b)
    if ra.std() == 0 or rb.std() == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def within_task_spearman(frame: pd.DataFrame) -> tuple[float, int, int]:
    """Mean within-task rho, plus how many tasks it covers and how many it could not.

    Two different "no correlation" cases, kept apart:

      * The PREDICTION has no spread — a constant model orders nothing, so it
        earns rho 0. That is a real score, and it is the baseline the rest are
        read against.
      * The ACTUAL placements have no spread — a whole field on one score, so
        there is no ordering to agree about. Those tasks are counted out loud
        and left out of the mean, rather than scored 0, which would be a claim
        the data does not support.
    """
    rhos, undefined = [], 0
    for _, task in frame.groupby("task_key"):
        actual = task["actual"].to_numpy()
        pred = task["pred"].to_numpy()
        if len(task) < 3 or np.ptp(actual) == 0:
            undefined += 1
            continue
        rho = spearman(pred, actual)
        rhos.append(0.0 if np.isnan(rho) else rho)
    return (float(np.mean(rhos)) if rhos else float("nan"), len(rhos), undefined)


def precision_at_k(frame: pd.DataFrame, k: int, seed: int = 0) -> tuple[float, int]:
    """Share of the predicted top k that is really in the top k, over tasks big enough.

    Ties in the prediction are broken at random, not by row order. The feature
    store is written in placement order, so an order-preserving tie-break would
    hand a constant predictor a perfect P@3 — a pure artefact of how the file
    is laid out, and one that reads exactly like a result.
    """
    rng = np.random.default_rng(seed)
    hits, tasks = [], 0
    for _, task in frame.groupby("task_key", sort=True):
        if len(task) < k:
            continue
        tasks += 1
        jitter = rng.random(len(task))
        order = np.lexsort((jitter, -task["pred"].to_numpy()))
        true_order = np.lexsort((jitter, -task["actual"].to_numpy()))
        hits.append(len(set(order[:k]) & set(true_order[:k])) / k)
    return (float(np.mean(hits)) if hits else float("nan"), tasks)


def auc(labels: np.ndarray, scores: np.ndarray) -> float:
    """Rank-based AUC: the probability a positive outranks a negative."""
    positives = labels == 1
    n_pos, n_neg = int(positives.sum()), int((~positives).sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = _rank(scores)
    return float((ranks[positives].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def rank_calibrated(frame: pd.DataFrame) -> np.ndarray:
    """Predictions re-expressed as a within-task percentile, 1 = predicted winner.

    A listwise model is trained to ORDER a field and its scores carry no
    scale: comparing them to a percentile label directly reports an error that
    is an artefact of the loss, not of the model. Reading each prediction as
    its own rank within its task puts every model — constant, OLS, listwise,
    pointwise — on the one scale the label lives on. rho and P@k are invariant
    to this, so only MAE and AUC change.
    """
    out = np.empty(len(frame), dtype=np.float64)
    positions = np.arange(len(frame))
    for _, task in frame.groupby("task_key", sort=False):
        idx = positions[frame.index.get_indexer(task.index)]
        n = len(task)
        if n == 1:
            out[idx] = 1.0
            continue
        ranks = _rank(-task["pred"].to_numpy())
        out[idx] = (n - ranks) / (n - 1)
    return out


def evaluate(frame: pd.DataFrame) -> dict:
    """Every headline metric over one set of predictions.

    `frame` needs `task_key`, `pred`, `actual` (the percentile label), and
    `top_quartile`, with a fresh 0..n-1 index.
    """
    rho, scored_tasks, undefined_tasks = within_task_spearman(frame)
    p3, tasks3 = precision_at_k(frame, 3)
    p10, tasks10 = precision_at_k(frame, 10)
    calibrated = rank_calibrated(frame)
    return {
        "rows": int(len(frame)),
        "tasks": int(frame["task_key"].nunique()),
        "spearman_within_task": rho,
        "spearman_tasks_scored": scored_tasks,
        "spearman_tasks_undefined": undefined_tasks,
        "precision_at_3": p3,
        "precision_at_3_tasks": tasks3,
        "precision_at_10": p10,
        "precision_at_10_tasks": tasks10,
        "auc_top_quartile": auc(frame["top_quartile"].to_numpy(), calibrated),
        "auc_top_quartile_raw": auc(
            frame["top_quartile"].to_numpy(), frame["pred"].to_numpy()
        ),
        "mae_percentile": float(np.abs(calibrated - frame["actual"]).mean()),
        "mae_percentile_raw": float(np.abs(frame["pred"] - frame["actual"]).mean()),
    }


def print_table(results: dict) -> None:
    """The results file as a table: one row per model, per fold and pooled."""
    arm = results.get("arm", "?")
    print(f"\n=== {results.get('title', 'results')} — {arm} ===")
    print(
        f"{'model':<28} {'rho':>7} {'per fold':>34} {'P@3':>6} {'P@10':>6} "
        f"{'AUC':>6} {'MAE':>6}"
    )
    for model in results["models"]:
        folds = " ".join(f"{f['spearman_within_task']:+.2f}" for f in model["folds"])
        pooled = model["pooled"]
        print(
            f"{model['name']:<28} {pooled['spearman_within_task']:>7.3f} {folds:>34} "
            f"{pooled['precision_at_3']:>6.3f} {pooled['precision_at_10']:>6.3f} "
            f"{pooled['auc_top_quartile']:>6.3f} {pooled['mae_percentile']:>6.3f}"
        )
    undefined = max(m["pooled"]["spearman_tasks_undefined"] for m in results["models"])
    if undefined:
        print(
            f"\n  {undefined} task-class(es) carry no ordering to agree about — "
            "fewer than three\n  pilots, or a whole field on one score — and are "
            "left out of rho."
        )
    print(
        "\n  rho is the mean WITHIN-task Spearman correlation between predicted "
        "and actual\n  placement. Per-fold columns are whole held-out competitions."
    )
    print(
        "  P@k counts every task-class with at least k pilots, so the small "
        "floater\n  classes give it a high chance floor — read it against the "
        "constant row, which\n  IS that floor, rather than against zero."
    )
    print(
        "  AUC and MAE are computed on the prediction re-expressed as a "
        "within-task\n  percentile, so a listwise model — whose scores carry "
        "no scale — is on the same\n  axis as the label and as every other row. "
        "The raw figures are in the JSON."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path, help="a JSON file written by baselines.py")
    args = parser.parse_args()
    print_table(json.loads(args.results.read_text()))


if __name__ == "__main__":
    main()
