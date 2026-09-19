#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "numpy",
#     "pandas",
#     "torch",
# ]
# ///
"""The feature MLP — steps 4 and 5 of the track-placement experiment (#692).

A per-track scoring function `f(track, task, weather) -> scalar`. The network
never sees more than one track. The LOSS is what knows about the field:

  * **Listwise (headline)** — a Plackett-Luce / ListNet softmax over the
    tracks of one task-class, so the model is trained to order a field it
    cannot see. This is the honest formulation of the question.
  * **Pointwise (comparison)** — plain regression on `percentile` plus a
    `top_decile` classification head, for calibration and for a probability
    that reads as "how likely is this track to place well".

Two arms, and the second is the real one:

  * `--arm retrospective` — the whole flight is visible. Largely carried by
    distance flown; its job is to be the reference number.
  * `--arm prospective` — everything up to the start-cylinder crossing and
    nothing after it. Can the climb up, the wait, and the way a pilot enters
    the start tell you how the race ends?

Evaluation is 5-fold, holding out whole COMPETITIONS, scored by the same
`report.py` the baselines use. Every number is reported per fold as well as
pooled: a fold holding out Forbes is holding out flatlands aerotow hang
gliding, and the spread is part of the finding.

CPU only — a model this size trains in minutes. (On Apple Silicon the default
PyPI wheel is already CPU/MPS; a Linux run should add uv's pytorch-cpu index
rather than pull the CUDA build.)

Usage:
  uv run experiments/track-placement/train.py --arm prospective
  uv run experiments/track-placement/train.py --arm retrospective --loss pointwise
  uv run experiments/track-placement/train.py --arm prospective --weather none
  uv run experiments/track-placement/train.py --arm prospective --blocks task,start
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn


def _load_sibling(name: str):
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

DEVICE = torch.device("cpu")


class TrackScorer(nn.Module):
    """Standardised features + a wing embedding -> one scalar per track.

    Deliberately small. About 4 900 samples is not much for anything deep, so
    the width, the depth and the dropout are all set by that rather than by
    what the data could support if there were ten times as much of it.
    """

    def __init__(self, n_features: int, n_wings: int, hidden: int = 128, dropout: float = 0.3):
        super().__init__()
        self.wing = nn.Embedding(n_wings, 4)
        self.body = nn.Sequential(
            nn.Linear(n_features + 4, hidden),
            nn.LayerNorm(hidden),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(hidden, hidden // 2),
            nn.LayerNorm(hidden // 2),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        # Two heads on one trunk: the score the ordering is read from, and the
        # "placed well" probability that makes the output calibratable.
        self.score = nn.Linear(hidden // 2, 1)
        self.top = nn.Linear(hidden // 2, 1)

    def forward(self, x: torch.Tensor, wing: torch.Tensor):
        h = self.body(torch.cat([x, self.wing(wing)], dim=1))
        return self.score(h).squeeze(1), self.top(h).squeeze(1)


def listwise_loss(scores: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """ListNet cross-entropy over one task-class.

    Both sides become a softmax distribution over the field, and the loss is
    the cross-entropy between them. A model that has the ORDER right pays
    almost nothing even if its scores are on a different scale, which is
    exactly the invariance the headline metric has.
    """
    return -(torch.softmax(target, dim=0) * torch.log_softmax(scores, dim=0)).sum()


def make_groups(frame: pd.DataFrame, rows: np.ndarray) -> list[np.ndarray]:
    """Row indices grouped by task-class — one field per listwise batch."""
    keys = frame["task_key"].to_numpy()[rows]
    order = np.argsort(keys, kind="mergesort")
    groups, start = [], 0
    ordered = keys[order]
    for i in range(1, len(ordered) + 1):
        if i == len(ordered) or ordered[i] != ordered[start]:
            groups.append(rows[order[start:i]])
            start = i
    return groups


def split_validation(
    frame: pd.DataFrame, train_rows: np.ndarray, seed: int
) -> tuple[np.ndarray, np.ndarray]:
    """Carve a validation set out of the TRAINING comps, by whole comps.

    Early stopping on rows drawn from the training comps would stop on the day
    rather than on the flying, for the same reason the outer folds hold out
    whole competitions.
    """
    comps = np.unique(frame["comp"].to_numpy()[train_rows])
    rng = np.random.default_rng(seed)
    held = set(rng.permutation(comps)[: max(1, len(comps) // 5)])
    mask = np.isin(frame["comp"].to_numpy()[train_rows], list(held))
    return train_rows[~mask], train_rows[mask]


def train_fold(
    frame: pd.DataFrame,
    columns: list[str],
    fold,
    loss_kind: str,
    epochs: int,
    seed: int,
    hidden: int = 128,
    dropout: float = 0.3,
) -> tuple[np.ndarray, float]:
    torch.manual_seed(seed + fold.index)
    values = dataset.matrix(frame, columns)
    fit_rows, val_rows = split_validation(frame, fold.train_rows, seed + fold.index)

    train_x, _, _ = dataset.standardise(values[fit_rows], values[fit_rows])
    _, val_x, _ = dataset.standardise(values[fit_rows], values[val_rows])
    _, test_x, _ = dataset.standardise(values[fit_rows], values[fold.test_rows])

    wings = pd.Categorical(frame["wing"]).codes.astype(np.int64)
    percentile = frame["label.percentile"].to_numpy(dtype=np.float64)
    top_decile = frame["label.top_decile"].to_numpy(dtype=np.float64)

    def tensors(rows, matrix):
        return (
            torch.tensor(matrix, dtype=torch.float32, device=DEVICE),
            torch.tensor(wings[rows], device=DEVICE),
            torch.tensor(percentile[rows], dtype=torch.float32, device=DEVICE),
            torch.tensor(top_decile[rows], dtype=torch.float32, device=DEVICE),
        )

    tx, tw, tp, tt = tensors(fit_rows, train_x)
    vx, vw, vp, vt = tensors(val_rows, val_x)
    sx, sw, _, _ = tensors(fold.test_rows, test_x)

    model = TrackScorer(
        train_x.shape[1], int(wings.max()) + 1, hidden=hidden, dropout=dropout
    ).to(DEVICE)
    optimiser = torch.optim.AdamW(model.parameters(), lr=2e-3, weight_decay=1e-2)
    bce = nn.BCEWithLogitsLoss()

    # Listwise batches are whole fields; the group indices are into fit_rows.
    local = np.arange(len(fit_rows))
    frame_fit = frame.iloc[fit_rows].reset_index(drop=True)
    groups = make_groups(frame_fit, local)
    val_groups = make_groups(frame.iloc[val_rows].reset_index(drop=True), np.arange(len(val_rows)))

    best_val, best_state, patience = float("inf"), None, 0
    rng = np.random.default_rng(seed + fold.index)
    for _ in range(epochs):
        model.train()
        for index in rng.permutation(len(groups)):
            group = torch.tensor(groups[index], device=DEVICE)
            optimiser.zero_grad()
            scores, top = model(tx[group], tw[group])
            if loss_kind == "listwise":
                loss = listwise_loss(scores, tp[group] * 4.0) + 0.2 * bce(top, tt[group])
            else:
                loss = nn.functional.mse_loss(scores, tp[group]) + 0.2 * bce(top, tt[group])
            loss.backward()
            optimiser.step()

        model.eval()
        with torch.no_grad():
            scores, top = model(vx, vw)
            if loss_kind == "listwise":
                val = sum(
                    listwise_loss(scores[torch.tensor(g)], vp[torch.tensor(g)] * 4.0).item()
                    for g in val_groups
                ) / max(1, len(val_groups))
            else:
                val = nn.functional.mse_loss(scores, vp).item()
        if val < best_val - 1e-5:
            best_val, patience = val, 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            patience += 1
            if patience >= 12:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        scores, _ = model(sx, sw)
    # The validation loss comes back with the predictions so a configuration
    # can be chosen on held-out TRAINING comps rather than on the test fold.
    return scores.cpu().numpy(), best_val


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=None)
    parser.add_argument(
        "--arm", choices=["retrospective", "prospective"], default="prospective"
    )
    parser.add_argument("--loss", choices=["listwise", "pointwise"], default="listwise")
    parser.add_argument(
        "--weather",
        choices=["all", "era5", "forecast", "none"],
        default="all",
        help="the forecast ablation arm: 'none' drops every wx.* block",
    )
    parser.add_argument(
        "--blocks",
        default="all",
        help="comma-separated feature blocks to keep "
        f"({', '.join(dataset.ABLATABLE_BLOCKS)}), or 'all'",
    )
    parser.add_argument("--folds", type=int, default=5)
    parser.add_argument("--epochs", type=int, default=120)
    parser.add_argument("--hidden", type=int, default=128)
    parser.add_argument("--dropout", type=float, default=0.3)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    root = args.store or dataset.archive_root()
    frame = dataset.load_store(root / "features")
    rows = dataset.arm_rows(frame, args.arm).reset_index(drop=True)
    blocks = (
        None
        if args.blocks == "all"
        else {b.strip() for b in args.blocks.split(",") if b.strip()}
    )
    if blocks is not None:
        unknown = blocks - set(dataset.ABLATABLE_BLOCKS)
        if unknown:
            raise SystemExit(f"Unknown block(s): {', '.join(sorted(unknown))}")
    columns = dataset.arm_columns(rows, args.arm, weather=args.weather, blocks=blocks)
    columns, dropped = dataset.usable_columns(rows, columns)
    folds = dataset.make_folds(rows, args.folds, seed=args.seed)

    print(
        f"{args.arm} / {args.loss} / weather={args.weather} / blocks={args.blocks}: "
        f"{len(rows)} rows, {rows['task_key'].nunique()} task-classes, "
        f"{len(columns)} features"
        + (f" ({len(dropped)} dropped as never populated)" if dropped else "")
    )

    predictions = np.full(len(rows), np.nan)
    val_losses = []
    for fold in folds:
        predictions[fold.test_rows], val_loss = train_fold(
            rows, columns, fold, args.loss, args.epochs, args.seed,
            hidden=args.hidden, dropout=args.dropout,
        )
        val_losses.append(val_loss)
        print(
            f"  fold {fold.index} done ({len(fold.test_rows)} held-out rows, "
            f"val loss {val_loss:.4f})"
        )

    scored = pd.DataFrame(
        {
            "task_key": rows["task_key"].to_numpy(),
            "pred": predictions,
            "actual": rows["label.percentile"].to_numpy(dtype=np.float64),
            "top_quartile": rows["label.top_quartile"].to_numpy(dtype=np.float64),
        }
    )
    results = {
        "title": f"Feature MLP ({args.loss}, weather={args.weather}, blocks={args.blocks})",
        "blocks": args.blocks,
        "arm": args.arm,
        "rows": int(len(rows)),
        "features": len(columns),
        "hidden": args.hidden,
        "dropout": args.dropout,
        "mean_validation_loss": float(np.mean(val_losses)),
        "folds": [{"index": f.index, "comps": f.comps} for f in folds],
        "models": [
            {
                "name": f"MLP {args.loss} wx={args.weather} blocks={args.blocks}",
                "folds": [
                    report.evaluate(scored.iloc[f.test_rows].reset_index(drop=True))
                    for f in folds
                ],
                "pooled": report.evaluate(scored),
            }
        ],
    }
    report.print_table(results)
    print(f"  mean inner-validation loss {results['mean_validation_loss']:.4f}")
    if args.out:
        args.out.write_text(json.dumps(results, indent=2) + "\n")
        print(f"\n  wrote {args.out}")


if __name__ == "__main__":
    main()
