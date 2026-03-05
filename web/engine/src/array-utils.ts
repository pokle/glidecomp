/**
 * Stack-safe array utilities.
 *
 * Common patterns like `Math.max(...array)` spread every element onto the
 * call stack as a separate function argument. This works for small arrays
 * but crashes with a RangeError ("Maximum call stack size exceeded") when
 * the array length exceeds the engine's argument limit — typically somewhere
 * between 10,000 and 65,536 depending on the JS engine and platform.
 *
 * IGC track logs routinely contain 10,000–40,000 fixes (1-second recording
 * over multi-hour flights), so spread-based min/max is not safe for fix arrays.
 * The functions here use simple loops with no stack pressure.
 */

/**
 * Returns the maximum value produced by `fn` across all elements of `items`.
 *
 * Returns -Infinity for empty arrays, matching `Math.max()` with no arguments.
 */
export function maxBy<T>(items: readonly T[], fn: (item: T) => number): number {
  let max = -Infinity;
  for (const item of items) {
    const v = fn(item);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Returns the minimum value produced by `fn` across all elements of `items`.
 *
 * Returns Infinity for empty arrays, matching `Math.min()` with no arguments.
 */
export function minBy<T>(items: readonly T[], fn: (item: T) => number): number {
  let min = Infinity;
  for (const item of items) {
    const v = fn(item);
    if (v < min) min = v;
  }
  return min;
}
