// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

// Auto-derived usernames. A username is a public handle (it appears in
// /u/:username URLs and public-by-link file paths), so it must be format-valid
// and unique. Rather than force every new user to pick one during onboarding,
// we derive one from their name/email at sign-up and let them keep it.
//
// The output always satisfies the same rules the manual /api/auth/set-username
// endpoint enforces: 3-20 chars, lowercase [a-z0-9-], and no leading/trailing
// hyphen (matches ^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$).

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

// Used when a name/email yields nothing usable (e.g. a name that's all emoji).
const FALLBACK_BASE = "pilot";

// Combining diacritical marks left behind by NFKD decomposition (U+0300-036F).
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Turn an arbitrary display name or email local-part into a username *base*:
 * accents folded to ASCII, lowercased, every run of other characters collapsed
 * to a single hyphen, and no leading/trailing hyphen. May be shorter than
 * USERNAME_MIN_LENGTH or empty - the caller decides the fallback.
 */
export function slugifyUsername(input: string): string {
  return input
    .normalize("NFKD") // decompose accents: "e-acute" -> "e" + combining mark
    .replace(COMBINING_MARKS, "") // drop the combining marks NFKD left behind
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics -> one hyphen
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
}

function stripTrailingHyphens(s: string): string {
  return s.replace(/-+$/g, "");
}

/**
 * Derive a unique, format-valid username at sign-up time.
 *
 * `candidates` are tried in order (typically [name, email-local-part]); the
 * first that slugifies to at least USERNAME_MIN_LENGTH characters becomes the
 * base, else FALLBACK_BASE. If the base is taken, append -2, -3, ... (keeping
 * the whole thing within USERNAME_MAX_LENGTH) until `isTaken` reports one free.
 *
 * A concurrent sign-up could still race between the isTaken check and the
 * insert; the UNIQUE constraint on user.username is the authoritative guard.
 */
export async function deriveUniqueUsername(
  candidates: string[],
  isTaken: (username: string) => Promise<boolean>
): Promise<string> {
  let base = "";
  for (const candidate of candidates) {
    const slug = stripTrailingHyphens(slugifyUsername(candidate ?? "").slice(0, USERNAME_MAX_LENGTH));
    if (slug.length >= USERNAME_MIN_LENGTH) {
      base = slug;
      break;
    }
  }
  if (!base) base = FALLBACK_BASE;

  if (!(await isTaken(base))) return base;

  for (let n = 2; n <= 9999; n++) {
    const suffix = `-${n}`;
    const stem = stripTrailingHyphens(base.slice(0, USERNAME_MAX_LENGTH - suffix.length));
    const candidate = `${stem}${suffix}`;
    if (!(await isTaken(candidate))) return candidate;
  }

  // 9998 collisions on one base is not something a real sign-up reaches; the DB
  // UNIQUE constraint will reject a dupe insert regardless, so failing loudly
  // here is the correct floor.
  throw new Error(`could not derive a unique username from base "${base}"`);
}
