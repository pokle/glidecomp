/**
 * A team is stored under the spelling its roster already uses.
 *
 * Teams are scored by their exact name (the scores page's Teams tab and the
 * results record group by it), so "Alpha Gliders" and "alpha  gliders" would
 * be published as two teams with two totals. The pilot sheet's Team field
 * already offers the roster's teams and snaps to their spelling
 * (src/react/comp/team-names.ts); this is the same rule where every write
 * lands, so a CSV import, an API key or an assistant cannot split a team
 * either.
 *
 * Only a name that IS the team — equal once case, spacing and accents are
 * ignored — is rewritten. A near miss ("Alpha Gilders") may be a different
 * team, and is left exactly as given: names may propose, never dispose.
 */

/** Letters Unicode does not decompose (as the client folds them). */
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

/** What two spellings of one team share. */
export function teamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øłđðþæœßı]/g, (ch) => FOLD_EXTRA[ch] ?? ch)
    .replace(/\s+/g, " ")
    .trim();
}

/** A name as stored when no team claims it: trimmed, inner spaces collapsed. */
function tidy(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * Hands out the stored spelling for each team name, against a set of
 * spellings already on the roster. Names it has not seen join the set in the
 * order they are asked about, so two new rows in one import that spell a
 * new team two ways still land as one team.
 */
export class TeamSpellings {
  private readonly byKey = new Map<string, string>();

  /** `existing`: team names already on the roster, most-used first wins. */
  constructor(existing: Array<string | null | undefined>) {
    const counts = new Map<string, Map<string, number>>();
    for (const raw of existing) {
      const name = raw ? tidy(raw) : "";
      if (!name) continue;
      const key = teamKey(name);
      const spellings = counts.get(key) ?? new Map<string, number>();
      spellings.set(name, (spellings.get(name) ?? 0) + 1);
      counts.set(key, spellings);
    }
    for (const [key, spellings] of counts) {
      const [name] = [...spellings.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0];
      this.byKey.set(key, name);
    }
  }

  /** The spelling to store for `name`; blank stays blank (null). */
  spell(name: string | null | undefined): string | null {
    if (name === null || name === undefined) return name ?? null;
    const tidied = tidy(name);
    if (!tidied) return null;
    const key = teamKey(tidied);
    const known = this.byKey.get(key);
    if (known) return known;
    this.byKey.set(key, tidied);
    return tidied;
  }
}

/** The team names on a roster, optionally leaving some rows out. */
export async function rosterTeamNames(
  db: D1Database,
  compId: number,
  exceptCompPilotIds: number[] = []
): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT comp_pilot_id, team_name FROM comp_pilot WHERE comp_id = ? AND team_name IS NOT NULL"
    )
    .bind(compId)
    .all<{ comp_pilot_id: number; team_name: string }>();
  const except = new Set(exceptCompPilotIds);
  return rows.results.filter((r) => !except.has(r.comp_pilot_id)).map((r) => r.team_name);
}
