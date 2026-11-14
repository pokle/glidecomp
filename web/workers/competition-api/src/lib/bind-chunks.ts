/**
 * D1 rejects a statement with more than 100 bound parameters ("too many SQL
 * variables"). The local SQLite the tests run on allows 32,766, so a query
 * that binds a list of ids passes every test and fails in production the day
 * the list grows past the limit.
 *
 * So a list of ids that goes into an `IN (...)` is split into runs, one
 * statement each. The size leaves room for a few other parameters beside the
 * list; a statement that binds the same list more than once divides it
 * (`chunkForBinds(ids, 2)`).
 */
export const D1_BIND_CHUNK = 90;

/** `values` in runs of at most `D1_BIND_CHUNK / timesBound`. Empty in, empty out. */
export function chunkForBinds<T>(values: readonly T[], timesBound = 1): T[][] {
  const size = Math.max(1, Math.floor(D1_BIND_CHUNK / timesBound));
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/** `?,?,?` for a list of `n` values. */
export function bindList(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}
