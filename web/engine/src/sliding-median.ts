// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Exact multiset median over a known (offline) value universe.
 *
 * Why: the altitude-cleaning rolling baseline needs the median of a sliding
 * window whose two ends only ever move forward. Rebuilding and sorting the
 * window per fix is O(N² log N) when degenerate timestamps make every window
 * span the whole track (issue #470, SEC-32) — an adversarial IGC file turns
 * that into a per-upload CPU sink. Because every value the window will ever
 * hold is known before the sweep starts, an order-statistic Fenwick tree over
 * the sorted-unique universe gives the SAME median — the k-th order statistics
 * of a multiset are value-determined, so this is bit-identical to the
 * sort-and-index path it replaces — in O(log m) per operation.
 *
 * Not a general-purpose structure: `add`/`remove` throw on a value that was
 * not in the constructor's universe, and −0 is conflated with +0 (values are
 * canonicalised with `v + 0`), exactly as `Array.prototype.sort` with a
 * numeric comparator would interleave them.
 */
export class SlidingMedian {
  /** Sorted unique non-NaN universe values; index is the value's rank. */
  private readonly sorted: Float64Array;
  /** 1-indexed Fenwick tree of live counts per rank. */
  private readonly tree: Int32Array;
  /** Highest power of two ≤ universe size, for the k-th-element descent. */
  private readonly topStep: number;
  private live = 0;

  /** `universe`: every value `add()` may ever receive. NaN entries ignored. */
  constructor(universe: ArrayLike<number>) {
    const values: number[] = [];
    for (let i = 0; i < universe.length; i++) {
      const v = universe[i] + 0; // canonicalise −0 → +0
      if (!Number.isNaN(v)) values.push(v);
    }
    values.sort((a, b) => a - b);
    let m = 0;
    const sorted = new Float64Array(values.length);
    for (let i = 0; i < values.length; i++) {
      if (m === 0 || values[i] !== sorted[m - 1]) sorted[m++] = values[i];
    }
    this.sorted = sorted.slice(0, m);
    this.tree = new Int32Array(m + 1);
    let step = 1;
    while (step * 2 <= m) step *= 2;
    this.topStep = step;
  }

  /** 0-based rank of an exact universe member; throws otherwise. */
  private rankOf(value: number): number {
    const v = value + 0;
    const s = this.sorted;
    let lo = 0;
    let hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    if (s[lo] !== v) throw new Error(`SlidingMedian: ${value} is not in the universe`);
    return lo;
  }

  add(value: number): void {
    const m = this.sorted.length;
    for (let i = this.rankOf(value) + 1; i <= m; i += i & -i) this.tree[i]++;
    this.live++;
  }

  /** Remove one live copy of `value`. The caller must only remove members it added. */
  remove(value: number): void {
    const m = this.sorted.length;
    for (let i = this.rankOf(value) + 1; i <= m; i += i & -i) this.tree[i]--;
    this.live--;
  }

  /** Live member count. */
  size(): number {
    return this.live;
  }

  /** k-th smallest live value, 0-based, by Fenwick binary-lifting descent. */
  private kth(k: number): number {
    if (k < 0 || k >= this.live) throw new Error(`SlidingMedian: rank ${k} of ${this.live}`);
    let idx = 0; // 1-indexed tree position; counts items at ranks < idx
    let remaining = k + 1;
    for (let step = this.topStep; step > 0; step >>= 1) {
      const next = idx + step;
      if (next <= this.sorted.length && this.tree[next] < remaining) {
        idx = next;
        remaining -= this.tree[next];
      }
    }
    return this.sorted[idx]; // idx items are strictly smaller, so rank idx is the answer
  }

  /** The ((size−1) >> 1)-th smallest — the lower middle (== upper for odd sizes). */
  medianLow(): number {
    return this.kth((this.live - 1) >> 1);
  }

  /** The (size >> 1)-th smallest — the upper middle (== lower for odd sizes). */
  medianHigh(): number {
    return this.kth(this.live >> 1);
  }
}
