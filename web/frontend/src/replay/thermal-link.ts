// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The `?thermal=` deep link — the analysis page's "watch this thermal" lands
 * here, and the replay's own thermal picker writes it back so the selection
 * IS the shareable link.
 *
 * Parsing lives here, apart from the entry point, because the absent case is
 * the one that matters and the one that is easy to get wrong: an absent
 * param must read as "no deep link", never as thermal 0.
 */

/**
 * The thermal id a replay URL asks for, or null when it asks for none.
 *
 * `URLSearchParams.get()` answers null for an absent param and `Number(null)`
 * is 0 — a perfectly good thermal id — so a naive `Number(get(...))` makes
 * every plain replay load open as a deep link into thermal 0. Only a string
 * that is genuinely an integer counts.
 */
export function parseThermalParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('thermal');
  if (raw === null || raw.trim() === '') return null;
  const id = Number(raw);
  return Number.isInteger(id) ? id : null;
}
