/**
 * Split plain text into text and web links, for notes an organiser typed
 * (the comp's organiser notes and a task's weather notes). Pure and SSR-safe.
 *
 * The text stays text: nothing here produces markup, and the caller renders
 * each part as a React text node or an `<a>` whose children are the URL as
 * written. So the link a reader sees is always where it goes — there is no
 * `[label](url)` form to disguise one.
 *
 * Only `http:` and `https:` become links. A candidate must start with
 * `http://` or `https://` (any case), and is then parsed with the WHATWG URL
 * parser the browser itself uses; anything whose protocol is not exactly
 * `http:` or `https:` stays text. `javascript:`, `data:`, `vbscript:` and the
 * rest can therefore never reach an `href` — not by mixed case, not by
 * embedded whitespace, not by an entity (there is no HTML to decode one).
 * The same rule as `safeExternalUrl` in the competition worker's score route.
 */

export type TextPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string };

const CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi;

/** Sentence punctuation that ends a sentence, not a URL. */
const TRAILING = /[.,;:!?'"\]}>]+$/;

/**
 * Drop trailing sentence punctuation, and a closing parenthesis that has no
 * opening partner inside the URL ("(see https://x.com/a)" vs
 * "https://en.wikipedia.org/wiki/Glider_(sailplane)").
 */
function trimEnd(candidate: string): string {
  let s = candidate;
  for (;;) {
    const before = s;
    s = s.replace(TRAILING, "");
    if (s.endsWith(")")) {
      const open = (s.match(/\(/g) ?? []).length;
      const close = (s.match(/\)/g) ?? []).length;
      if (close > open) s = s.slice(0, -1);
    }
    if (s === before) return s;
  }
}

/** The URL to put in an `href`, or null if `text` is not a web link. */
export function webHref(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  const push = (t: string) => {
    if (!t) return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.text += t;
    else parts.push({ kind: "text", text: t });
  };
  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index ?? 0;
    const candidate = trimEnd(match[0]);
    const href = webHref(candidate);
    push(text.slice(at, start));
    if (href) {
      parts.push({ kind: "link", text: candidate, href });
      at = start + candidate.length;
    } else {
      at = start;
    }
  }
  push(text.slice(at));
  return parts;
}
