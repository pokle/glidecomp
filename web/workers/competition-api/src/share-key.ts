/**
 * The secret half of a hidden competition's link.
 *
 * A comp's id is a sequential number in a public Sqids encoding, so anyone can
 * list every id there is: the id is no secret, and "anyone who knows the id"
 * means everyone. A hidden (`test`) comp therefore opens for its admins and for
 * whoever holds its `share_key` — and the key travels INSIDE the comp's id, as
 * `${sqid}_${key}`:
 *
 *   /comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd/task/task-1-abcd
 *   /api/comp/vzuq_7hq2m9xk4rwd/task/abcd/score
 *
 * Every link the app builds and every API call it makes already carries the
 * comp's id, so the key goes everywhere the id goes and nothing has to
 * remember to pass it on. A link that drops it fails closed: not found.
 *
 * The organiser never looks for a "share" button: their own URL carries the
 * key, so the address bar IS the share link. "Reset link" writes a new key and
 * retires every link shared so far.
 *
 * The key opens a hidden comp for READING only. Every write route keeps
 * `hiddenFromCaller()` (admins only, SEC-37/38): a link is for looking at a
 * draft, not for registering into it or uploading a track.
 *
 * Every key is minted HERE, from `crypto.getRandomValues` — never in SQL,
 * whose random() is not documented as cryptographically secure. Migration
 * 0041 adds the column empty; a new comp is created with a key, and
 * `ensureShareKey()` fills one in for any comp that has none (those that
 * predate the column, or were written by the seeder or the importer) the
 * first time a hidden comp needs it. A NULL key opens nothing.
 */

/** Characters a key is drawn from. No `-` (the slug's separator) and no `_`
 * (the key's own), so `idFromSegment()` and `splitCompRef()` stay
 * unambiguous. */
const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const KEY_LENGTH = 12;

/** Exactly the keys this module mints. */
export const SHARE_KEY_RE = /^[a-z0-9]{12}$/;

/** Separates the comp's sqid from its key in a comp-id path segment. */
export const SHARE_KEY_SEPARATOR = "_";

/** A fresh key: 12 characters of [a-z0-9], about 62 bits. */
export function newShareKey(): string {
  // Rejection sampling: 252 is the largest multiple of 36 below 256, so every
  // character is equally likely.
  let out = "";
  while (out.length < KEY_LENGTH) {
    const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH * 2));
    for (const b of bytes) {
      if (b >= 252) continue;
      out += KEY_ALPHABET[b % 36];
      if (out.length === KEY_LENGTH) break;
    }
  }
  return out;
}

/**
 * Split a comp-id path segment into its sqid and its key.
 *
 * `vzuq` → `{ sqid: "vzuq" }`; `vzuq_7hq2m9xk4rwd` → `{ sqid, key }`. Returns
 * null for a segment that has a separator but no well-formed key after it,
 * so a mangled link answers 400 rather than quietly dropping the key.
 */
export function splitCompRef(
  ref: string
): { sqid: string; key?: string } | null {
  const i = ref.indexOf(SHARE_KEY_SEPARATOR);
  if (i === -1) return { sqid: ref };
  const sqid = ref.slice(0, i);
  const key = ref.slice(i + 1);
  if (!sqid || !SHARE_KEY_RE.test(key)) return null;
  return { sqid, key };
}

/** The comp-id segment a URL needs: the sqid, plus the key when there is one. */
export function compRef(sqid: string, key?: string | null): string {
  return key ? `${sqid}${SHARE_KEY_SEPARATOR}${key}` : sqid;
}

/**
 * The comp's share key, minting one first if it has none.
 *
 * Called where a hidden comp's key is about to be handed to someone entitled
 * to it — its admin opening the comp, or hiding it — so a comp that predates
 * the column, or that the seeder or the importer wrote, gets its key from
 * `newShareKey()` like every other. Safe to race: the UPDATE only fills an
 * empty column, and the re-read returns whichever key won.
 *
 * Not audited: it changes nothing anyone can see and no score. It only gives
 * a hidden comp the link it was always meant to have.
 */
export async function ensureShareKey(
  db: D1Database,
  compId: number,
  current: string | null | undefined
): Promise<string> {
  if (current) return current;
  await db
    .prepare("UPDATE comp SET share_key = ? WHERE comp_id = ? AND share_key IS NULL")
    .bind(newShareKey(), compId)
    .run();
  const row = await db
    .prepare("SELECT share_key FROM comp WHERE comp_id = ?")
    .bind(compId)
    .first<{ share_key: string | null }>();
  if (!row?.share_key) throw new Error(`comp ${compId} has no share key after minting one`);
  return row.share_key;
}

/**
 * Whether a presented key is the comp's key, in time independent of where the
 * two first differ. A missing key on either side never matches.
 */
export function shareKeyMatches(
  presented: string | null | undefined,
  actual: string | null | undefined
): boolean {
  if (!presented || !actual || presented.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= presented.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}
