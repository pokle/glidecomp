/**
 * Turning what someone typed — or what is left of a dead URL — into search
 * terms. Shared by the two endpoints that search names: /api/comp/search
 * (the competitions page) and /api/comp/lookup (the 404 page's repair).
 *
 * Both are public and unauthenticated, so the terms are capped in length and
 * count here, once, rather than in each caller.
 */

/** Longest search text accepted per field; anything beyond is truncated. */
export const MAX_TERM_CHARS = 120;
/** Most words used from one field. Extra words are dropped, not ANDed in. */
export const MAX_TOKENS = 5;
/** A single letter matches almost everything, so it is not a search term.
 *  A single DIGIT is (see searchTokens) — it is what separates Task 1 from
 *  Task 2, the commonest thing anyone looks up. */
export const MIN_TOKEN_CHARS = 2;

/**
 * Split search text into the words we match on: lowercased, alphanumeric,
 * capped in both length and count. A slug arrives here as "corryong-cup-2026"
 * and a typed query as "corryong cup 2026"; both reduce to the same words,
 * which is the whole point — the caller needn't know which it holds.
 *
 * One-character words are dropped unless they are digits. "a" narrows nothing,
 * but the "1" in `task-1-open` is the entire difference between Task 1 and
 * Task 2 — drop it and every task in the comp comes back as an equal match.
 *
 * Splitting on non-alphanumerics also means no operator of either query
 * language can survive into a token: not a LIKE wildcard for the lookup
 * endpoint, not an FTS5 operator (`"`, `*`, `:`, `^`, `-`, `(`, `)`, `AND`
 * is only special unquoted) for search. Each consumer quotes or escapes as
 * well, as the second of two barriers.
 */
export function searchTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .slice(0, MAX_TERM_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_CHARS || /^[0-9]$/.test(t))
    .slice(0, MAX_TOKENS);
}

/**
 * An FTS5 MATCH expression: every word required, the last one matched as a
 * prefix so the results narrow while someone is still typing it.
 *
 * Each token is a quoted string, which in FTS5 is a literal phrase — no
 * operator inside it is interpreted. Tokens are alphanumeric by the time they
 * get here, so the `"` doubling can never fire; it is there so that stays
 * true if searchTokens ever loosens.
 *
 * Only the LAST token gets `*`. A prefix match on every word would make
 * "ell kan" work, but it would also make "elliot" match "elliotson" in the
 * middle of a finished query, which reads as the wrong answer rather than an
 * incomplete one.
 */
export function buildMatchExpression(tokens: string[]): string {
  return ftsTerms(tokens).join(" AND ");
}

/**
 * The same, for a document that carries its competition's name in a column of
 * its own: every word somewhere in the document, AND at least one word outside
 * that `owner` column.
 *
 * Without the second half, searching a competition's name alone would return
 * every task and pilot in it — each one "matching" only because it names the
 * competition it belongs to. With it, "corryong" finds the competition,
 * "corryong kangck" still finds the task inside it, and "corryong harrison"
 * still finds the pilot. See migration 0026 for why the column exists.
 */
export function buildChildMatchExpression(tokens: string[]): string {
  const terms = ftsTerms(tokens);
  return `(${terms.join(" AND ")}) AND ({title route body} : (${terms.join(" OR ")}))`;
}

/** Each token as an FTS5 phrase; the last one as a prefix. */
function ftsTerms(tokens: string[]): string[] {
  return tokens.map((token, i) => {
    const phrase = `"${token.replace(/"/g, '""')}"`;
    return i === tokens.length - 1 ? `${phrase}*` : phrase;
  });
}
