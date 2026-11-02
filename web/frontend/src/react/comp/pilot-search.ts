/**
 * The pilots page's search box: which pilots a typed query finds.
 *
 * Built for an organiser at a registration desk on a hill, holding whatever a
 * pilot just told them or showed them — a name half-heard, a CIVL number off a
 * licence, a glider. So:
 *
 *   - **Every field an organiser might have in hand is searched**: name,
 *     email, the linked account's @username, glider, class, team, driver and
 *     all seven sporting-body IDs. Typing "sport" finds the Sport class, which
 *     is why the page has no separate class filter.
 *   - **Words match in any order, each anywhere.** "smi tom" finds Tom Smith,
 *     and "tom open" finds the Toms flying Open.
 *   - **Case and accents are ignored**, so "muller" finds Müller. An
 *     international field is full of names an English keyboard cannot type,
 *     and a phone keyboard makes typing them a chore anyway.
 *
 * Pure, so it is unit-tested rather than driven through the page.
 */
import type { CompPilot } from "./csv";

/**
 * Letters that Unicode does not decompose into a base letter plus a mark, so
 * stripping marks alone would leave them unmatched by the ASCII a reader
 * types. The ones that turn up in a hang-gliding field.
 */
const FOLD_EXTRA: Record<string, string> = {
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  æ: "ae",
  œ: "oe",
  ß: "ss",
  ı: "i",
};

/** Lower-cased with accents removed: "Müller" and "muller" fold alike. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øłđðþæœßı]/g, (ch) => FOLD_EXTRA[ch] ?? ch);
}

/** Everything a pilot can be found by, folded, one field per line. */
function haystack(p: CompPilot): string {
  return [
    p.name,
    p.email,
    p.linked_username ? `@${p.linked_username}` : null,
    p.glider,
    p.pilot_class,
    p.team_name,
    p.driver_contact,
    p.civl_id,
    p.safa_id,
    p.ushpa_id,
    p.bhpa_id,
    p.dhv_id,
    p.ffvl_id,
    p.fai_id,
  ]
    .filter((v): v is string => !!v)
    .map(fold)
    .join("\n");
}

/** The query as the words it must contain. Empty means "everyone". */
export function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Whether one pilot matches every word of the query. */
export function matchesPilot(p: CompPilot, query: string): boolean {
  const words = queryWords(query);
  if (words.length === 0) return true;
  const hay = haystack(p);
  return words.every((w) => hay.includes(w));
}

/** The pilots a query finds, in the order they were given. */
export function filterPilots(pilots: CompPilot[], query: string): CompPilot[] {
  if (queryWords(query).length === 0) return pilots;
  return pilots.filter((p) => matchesPilot(p, query));
}
