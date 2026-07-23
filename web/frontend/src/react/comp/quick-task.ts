/**
 * "Enter task" — build a whole route from one line of typing (prototype).
 *
 * A task setter reads a route out loud as a short list of waypoint codes and
 * cylinder sizes ("ell 400m ell 5k mitta cudg ncor 1k"). This module turns that
 * line into turnpoints: it splits the text into tokens, treats anything that
 * looks like a distance as the radius of the turnpoint before it, and fuzzy
 * matches every other token against the competition's waypoints.
 *
 * Matching is deliberately forgiving and always ranked — the UI shows the best
 * guess plus the runners-up, so a wrong pick is one tap to correct. DOM-free so
 * it's unit-testable (quick-task.test.ts).
 */
import type { WaypointFileRecord } from "@glidecomp/engine";

// ---------------------------------------------------------------------------
// Tokenizing
// ---------------------------------------------------------------------------

/** A distance: "400", "400m", "5k", "5km", "2.5km". Bare numbers are metres. */
const RADIUS_RE = /^(\d+(?:\.\d+)?)(m|k|km)?$/i;

export interface QuickToken {
  /** The text exactly as typed. */
  raw: string;
  /** Offset of `raw` in the input, so the UI can replace just this token. */
  start: number;
  end: number;
  /** Radius tokens carry metres; name tokens are matched against waypoints. */
  kind: "name" | "radius";
  /** Metres, for `kind: "radius"`. */
  metres?: number;
}

/** Metres for a radius token, or null when the token isn't a distance. */
export function parseRadiusToken(text: string): number | null {
  const m = RADIUS_RE.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "m").toLowerCase();
  const metres = unit === "m" ? value : value * 1000;
  return Math.round(metres);
}

/** One token: a run of anything that isn't a separator. */
const TOKEN_RE = /[^\s,]+/g;

/** A run of separators — what sits between two tokens. */
const SEPARATOR_RE = /^[\s,]+/;

/**
 * Split into tokens. Only whitespace and the comma separate turnpoints —
 * deliberately the smallest set that works, because every separator is a
 * character a waypoint code then can't contain. Real waypoint files are full
 * of codes like "Mt_Buffalo_-_Lookout" and "Gutt_Ridge_No.1"; a hyphen or a
 * dot in the separator set cuts those in half and invents a turnpoint. Of the
 * 1,250 waypoints in the bundled competitions, 84 contain a hyphen, 2 a dot,
 * none internal whitespace, and exactly one a comma. The comma has to be a
 * separator regardless: it's what the generated text puts between turnpoints.
 *
 * A separator never carries meaning: it's only ever where one turnpoint ends.
 */
export function tokenizeQuickTask(text: string): QuickToken[] {
  const tokens: QuickToken[] = [];
  const re = new RegExp(TOKEN_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const metres = parseRadiusToken(raw);
    tokens.push({
      raw,
      start: m.index,
      end: m.index + raw.length,
      ...(metres !== null
        ? { kind: "radius" as const, metres }
        : { kind: "name" as const }),
    });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Matching a name token to a waypoint
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/** Whether `query`'s letters appear in order in `text` (loose typo tolerance). */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i++;
    if (i === query.length) return true;
  }
  return query.length === 0;
}

/**
 * Dice coefficient over letter bigrams, 0..1 — a cheap similarity that copes
 * with the dropped letters real waypoint codes are full of ("mitta" vs
 * MTMITA, "cudgewa" vs CUDGWE), which the in-order rungs above miss.
 */
function bigramSimilarity(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  const pool = [...right];
  let shared = 0;
  for (const g of left) {
    const at = pool.indexOf(g);
    if (at >= 0) {
      shared++;
      pool.splice(at, 1);
    }
  }
  return (2 * shared) / (left.length + right.length);
}

/** Below this, a bigram match is noise rather than a plausible guess. */
const MIN_SIMILARITY = 0.4;

/**
 * How well a waypoint answers a typed fragment. Higher is better, 0 = no
 * match. The ladder, best first: exact code, code prefix, a name word's
 * prefix, code/name substring, letters-in-order, and finally near-enough
 * spelling. Within a rung the shorter candidate wins, so "ell" ranks ELLIOT
 * above ELLIOTP.
 */
export function scoreWaypoint(query: string, wp: WaypointFileRecord): number {
  const q = norm(query.trim());
  if (q === "") return 0;
  const code = norm(wp.code);
  const name = norm(wp.name ?? "");
  // Length penalty: never big enough to cross a rung (codes are short).
  const shorter = (text: string) => Math.max(0, 20 - Math.abs(text.length - q.length));

  if (code === q) return 1000;
  if (name === q) return 950;
  if (code.startsWith(q)) return 900 + shorter(code);
  if (name.split(/[^A-Z0-9]+/).some((w) => w.startsWith(q))) return 800 + shorter(name);
  if (code.includes(q)) return 700 + shorter(code);
  if (name.includes(q)) return 600 + shorter(name);
  if (isSubsequence(q, code)) return 500 + shorter(code);
  if (isSubsequence(q, name)) return 400 + shorter(name);
  // Last resort: near-enough spelling. Scored by similarity so the closest of
  // several loose matches leads.
  const similarity = Math.max(bigramSimilarity(q, code), bigramSimilarity(q, name));
  if (similarity >= MIN_SIMILARITY) return 100 + Math.round(similarity * 100);
  return 0;
}

/** The best waypoints for a fragment, best first (ties broken by code). */
export function matchWaypoints(
  query: string,
  waypoints: WaypointFileRecord[],
  limit = 6
): WaypointFileRecord[] {
  return waypoints
    .map((wp) => ({ wp, score: scoreWaypoint(query, wp) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.wp.code.localeCompare(b.wp.code))
    .slice(0, limit)
    .map((c) => c.wp);
}

/**
 * The matches worth *offering* for a fragment: the {@link matchWaypoints}
 * ranking, unless the token already spells a waypoint code exactly — then the
 * choice has been made and there is nothing to offer. Arrowing back through a
 * finished line sits the caret on one settled token after another, and a strip
 * re-offering the word already written is pure noise.
 *
 * The rule is "exact code" rather than "sole match" deliberately: on the
 * Corryong waypoint file a sole match is rare (ELLIOT has ELLITP, CUDG has
 * CUDGWE and CUDGNO), so the narrower rule would leave most settled tokens
 * still popping. Every prefix on the way to the exact code still suggests, so
 * ELLITP stays one keystroke back from a typed ELLIOT.
 */
export function suggestionsFor(
  query: string,
  waypoints: WaypointFileRecord[],
  limit = 6
): WaypointFileRecord[] {
  const q = norm(query.trim());
  if (waypoints.some((w) => norm(w.code) === q)) return [];
  return matchWaypoints(query, waypoints, limit);
}

// ---------------------------------------------------------------------------
// Parsing a whole line
// ---------------------------------------------------------------------------

export interface QuickTaskItem {
  /** The name token as typed ("ell"). */
  query: string;
  /** Token offsets in the input, for replace-in-place completion. */
  start: number;
  end: number;
  /** Radius in metres: from a following distance token, else the default. */
  radius: number;
  /** True when the radius came from the text rather than the default. */
  radiusExplicit: boolean;
  /** Type spelled out in the text ("ell 5k sss"); undefined = infer it. */
  explicitType?: QuickTypeWord;
  /** Ranked guesses, best first. Empty when nothing matched. */
  candidates: WaypointFileRecord[];
}

export interface ParseQuickTaskOptions {
  /** Radius for turnpoints with no distance token (metres). */
  defaultRadius: number;
  /** How many alternatives to keep per turnpoint. */
  candidateLimit?: number;
}

/**
 * Parse the whole line into turnpoints. A distance token applies to the name
 * before it ("ell 400m"); a distance typed *before* any name sets the default
 * for the rest of the line ("2k ell mitta" = two 2 km cylinders). A type word
 * ("ell 5k sss") types the turnpoint before it, overriding what position alone
 * would infer — that's how you say "two concentric cylinders at ELLIOT, the
 * first the take-off and the second the start".
 */
export function parseQuickTask(
  text: string,
  waypoints: WaypointFileRecord[],
  opts: ParseQuickTaskOptions
): QuickTaskItem[] {
  const tokens = tokenizeQuickTask(text);
  const items: QuickTaskItem[] = [];
  let runningDefault = opts.defaultRadius;

  for (const token of tokens) {
    const last = items[items.length - 1];
    if (token.kind === "radius") {
      if (last) {
        last.radius = token.metres!;
        last.radiusExplicit = true;
      } else {
        runningDefault = token.metres!;
      }
      continue;
    }
    const asType = typeAlias(token.raw);
    if (asType !== null && last && !isWaypointCode(token.raw, waypoints)) {
      last.explicitType = asType;
      continue;
    }
    items.push({
      query: token.raw,
      start: token.start,
      end: token.end,
      radius: runningDefault,
      radiusExplicit: false,
      candidates: matchWaypoints(token.raw, waypoints, opts.candidateLimit ?? 6),
    });
  }
  return items;
}

/**
 * The token the caret is sitting in — what the autocomplete should offer
 * suggestions for. Only a name token still being typed at the end of the text
 * counts; once you type a space you've moved on to the next turnpoint.
 */
export function activeToken(text: string, caret = text.length): QuickToken | null {
  const token = tokenizeQuickTask(text).find(
    (t) => caret >= t.start && caret <= t.end
  );
  return token && token.kind === "name" ? token : null;
}

/**
 * Replace one token with a waypoint code, leaving a trailing space so typing
 * carries straight on to the next turnpoint. Returns the new text and where
 * the caret should land.
 */
export function completeToken(
  text: string,
  token: { start: number; end: number },
  code: string
): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  // Drop the separator that followed the fragment: the completion supplies its
  // own space, so "ell/mit" + MITTA reads "ell/MITTA cudg", not "MITTA /cudg".
  const next = `${before}${code} ${after.replace(SEPARATOR_RE, "")}`;
  return { text: next, caret: before.length + code.length + 1 };
}

// ---------------------------------------------------------------------------
// Turnpoint types
// ---------------------------------------------------------------------------

/** "" | "TAKEOFF" | "SSS" | "ESS" for each turnpoint, by position. */
export type QuickType = "" | "TAKEOFF" | "SSS" | "ESS";

/**
 * A type as *spelled out in the text*. Wider than {@link QuickType}: the goal
 * and a plain turnpoint both end up untyped in an xctsk (the goal is simply
 * the last turnpoint), but saying "goal" and saying "tp" are different claims,
 * and only one of them is legal in the middle of a route.
 */
export type QuickTypeWord = "TAKEOFF" | "SSS" | "ESS" | "GOAL" | "NONE";

/** What you can type to set a turnpoint's type. */
const TYPE_ALIASES: Record<string, QuickTypeWord> = {
  to: "TAKEOFF",
  takeoff: "TAKEOFF",
  launch: "TAKEOFF",
  sss: "SSS",
  start: "SSS",
  ess: "ESS",
  goal: "GOAL",
  tp: "NONE",
  turnpoint: "NONE",
};

/** The type a word spells out, or null when it isn't a type word. */
export function typeAlias(word: string): QuickTypeWord | null {
  const key = word.trim().toLowerCase();
  return key in TYPE_ALIASES ? TYPE_ALIASES[key] : null;
}

/** Whether a token names a waypoint outright — those win over a type word, so
 *  a comp with a waypoint coded GOAL or START stays typeable. */
function isWaypointCode(word: string, waypoints: WaypointFileRecord[]): boolean {
  const q = norm(word.trim());
  return waypoints.some((w) => norm(w.code) === q);
}

/** The word to type for a type, for round-tripping a route back to text. */
const TYPE_WORDS: Record<Exclude<QuickType, "">, string> = {
  TAKEOFF: "to",
  SSS: "sss",
  ESS: "ess",
};

/**
 * The task structure a route of this length almost always has: the first
 * turnpoint is the take-off and the last is the goal (which carries no type);
 * given enough turnpoints the second is the start and the second-to-last the
 * ESS. Anything the text states explicitly overrides this — see resolveTypes.
 */
export function inferTypes(count: number): QuickType[] {
  const types: QuickType[] = Array.from({ length: count }, () => "");
  if (count === 0) return types;
  types[0] = "TAKEOFF";
  // 2 turnpoints is take-off + goal: there's no room for a speed section.
  // At 3 the middle one starts it; the ESS is then the goal itself, which is
  // how a short task is usually set, so it stays untyped.
  if (count >= 3) types[1] = "SSS";
  if (count >= 4) types[count - 2] = "ESS";
  return types;
}

/**
 * The type of every turnpoint: what the text says where that's a legal thing
 * to say, and inference for the rest. A task has exactly one of each role, so
 * the text is read the way a person means it rather than taken literally:
 *
 * - **The take-off is the first turnpoint.** "to" anywhere else is dropped —
 *   people do like to spell out both ends of a route, and a stray one in the
 *   middle is a mistake, not a second launch.
 * - **The goal is the last turnpoint**, same reasoning. ("tp" says "plain
 *   turnpoint" and is legal anywhere — it's how the round-trip says "leave
 *   this one untyped" without saying "goal".)
 * - **One SSS and one ESS**: if the text names several, the first wins and the
 *   rest are dropped.
 * - A role the text claims is never also placed by inference, wherever it was
 *   claimed — saying "sss" late in the route moves the start there rather than
 *   producing two.
 */
export function resolveTypes(items: Pick<QuickTaskItem, "explicitType">[]): QuickType[] {
  const count = items.length;
  const types: QuickType[] = Array.from({ length: count }, () => "");
  const claimed = new Set<QuickType>();
  const stated = new Array<boolean>(count).fill(false);

  items.forEach((item, i) => {
    const word = item.explicitType;
    if (!word) return;
    if (word === "TAKEOFF" && i !== 0) return;
    if (word === "GOAL" && i !== count - 1) return;
    if (word !== "GOAL" && word !== "NONE" && claimed.has(word)) return;
    stated[i] = true;
    if (word !== "GOAL" && word !== "NONE") {
      claimed.add(word);
      types[i] = word;
    }
  });

  // Fill the roles the text didn't claim, at the positions they usually sit.
  inferTypes(count).forEach((role, i) => {
    if (role === "" || stated[i] || claimed.has(role)) return;
    claimed.add(role);
    types[i] = role;
  });

  return types;
}

// ---------------------------------------------------------------------------
// Round-tripping a route back to text
// ---------------------------------------------------------------------------

/** Metres as the shortest thing you'd type: 400 → "400m", 5000 → "5k". */
export function radiusToken(metres: number): string {
  return metres >= 1000 && metres % 100 === 0
    ? `${+(metres / 1000).toFixed(1)}k`
    : `${Math.round(metres)}m`;
}

/**
 * Render a route as a quick-task line — the inverse of parseQuickTask, so the
 * field can show the route that's already loaded and stay editable as text.
 * Every turnpoint gets its radius spelled out (the thing most often missing
 * from what a setter types).
 *
 * `types` decides how much of the structure the line states:
 *
 * - `"needed"` (default) — a type word only where position wouldn't infer it,
 *   so the line is the shortest text that rebuilds this route. This is what
 *   the field mirrors a loaded route with.
 * - `"all"` — every role named: take-off, start, ESS and goal all spelled out.
 *   Longer, but it shows what the route IS rather than leaving it implied, and
 *   it puts each role somewhere you can edit. This is what Enter writes.
 *
 * Both forms round-trip to the same route; "all" is what the eye wants and
 * "needed" is what the fingers want.
 */
export function quickTaskText(
  turnpoints: { name: string; radius: number; type: QuickType }[],
  opts: { types?: "needed" | "all" } = {}
): string {
  const inferred = inferTypes(turnpoints.length);
  const last = turnpoints.length - 1;
  return turnpoints
    .map((tp, i) => {
      const parts = [tp.name.trim() || "?", radiusToken(tp.radius)];
      // "goal" only names the last turnpoint; elsewhere "tp" is how the text
      // says "plain turnpoint" without claiming a role it can't have.
      const word = tp.type ? TYPE_WORDS[tp.type] : i === last ? "goal" : "tp";
      // A word is *needed* wherever inference would produce something else —
      // without it the line wouldn't rebuild this route.
      const needed = tp.type !== inferred[i];
      const spellOut =
        opts.types === "all" ? tp.type !== "" || i === last || needed : needed;
      if (spellOut) parts.push(word);
      return parts.join(" ");
    })
    .join(", ");
}

// ---------------------------------------------------------------------------
// A worked example, from this competition's own waypoints
// ---------------------------------------------------------------------------

/** Radii an example draws from — the sizes tasks are actually set with. */
const EXAMPLE_RADII = [400, 1000, 2000, 5000];

/**
 * A plausible route written in the quick-task grammar, using waypoints this
 * competition actually has — the fastest way to see what the field wants,
 * and something to edit rather than a blank box. Types are left implied (the
 * positions infer them), so the line reads like something a setter would type.
 *
 * `rng` is injectable so the shape can be tested; the UI passes Math.random.
 */
export function randomExampleRoute(
  waypoints: WaypointFileRecord[],
  opts: { defaultRadius: number; size?: number; rng?: () => number }
): string {
  const rng = opts.rng ?? Math.random;
  if (waypoints.length === 0) return "";
  const wanted = opts.size ?? (rng() < 0.5 ? 4 : 5);
  const count = Math.max(1, Math.min(waypoints.length, wanted));

  // Draw without replacement: a route that visits the same waypoint twice is
  // a real shape (concentric cylinders), but a confusing thing to show first.
  const pool = [...waypoints];
  const picked: WaypointFileRecord[] = [];
  while (picked.length < count && pool.length > 0) {
    picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }

  const types = inferTypes(picked.length);
  return quickTaskText(
    picked.map((wp, i) => ({
      name: wp.code,
      radius:
        i === 0
          ? wp.radius > 0
            ? wp.radius
            : opts.defaultRadius
          : EXAMPLE_RADII[Math.floor(rng() * EXAMPLE_RADII.length)],
      type: types[i],
    }))
  );
}
