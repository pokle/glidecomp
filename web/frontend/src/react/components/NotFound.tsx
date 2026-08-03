/**
 * The 404 page — and, where it can be, a way out of it.
 *
 * Public GlideComp URLs are `${slug}-${id}` (`/comp/corryong-cup-2026-voqc/task/
 * task-1-open-bqlf/pilot/harrison-rowntree-zujf`). The id is the identity, but
 * the slug is a readable copy of the name, and it survives whatever happened to
 * the id. So rather than only apologising, this page reads the words out of the
 * dead path, asks the API which competitions / tasks / pilots carry those words
 * *now*, and offers the closest URLs that actually resolve — "did you mean …".
 * The dead URL rebuilt as itself (same page, live ids) leads the list: that is
 * the page the visitor asked for, and everything else is a consolation prize.
 *
 * Deliberately no "elsewhere on GlideComp" list of standing links: the header
 * nav and the footer already carry them on every page, this one included.
 *
 * That is defence in depth, not the fix: the seed script preserves the ids that
 * appear in URLs (web/scripts/lib/seed-identity.ts), so a re-seed no longer
 * breaks links in the first place. This catches everything else — a mistyped
 * link, a task an organizer deleted and re-created, a URL that was shared before
 * the ids were stable.
 *
 * Used for the router's catch-all AND from every public comp page's own
 * not-found branch, because those pages match a real route and so never reach
 * the catch-all: the id parses, it just doesn't resolve any more, which is
 * exactly the case worth repairing.
 *
 * SSR note: the eight server-rendered comp pages never render this (a 404 there is
 * served as the plain shell), but nothing here touches the DOM outside an
 * effect, so rendering it on the server would be harmless.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { Loading } from "@/react/rac/progress";
import { SearchField } from "@/react/rac/field";
import { fetchWithRetry } from "@/react/comp/types";
import {
  buildSuggestions,
  freeTextParams,
  lookupParams,
  parsePathIdentity,
  type LookupResults,
  type PathIdentity,
  type Suggestion,
} from "@/react/lib/not-found-search";

/** Typing pause before a search runs, so a query isn't sent per keystroke. */
const SEARCH_DEBOUNCE_MS = 300;

const EMPTY: LookupResults = { comps: [], tasks: [], pilots: [] };

const linkClass = "underline underline-offset-4 hover:text-foreground";

export function NotFound({
  title = "Page not found",
  /**
   * Replaces the first sentence when the caller knows something more specific
   * ("No score for this pilot on this task"). Do NOT pass a restatement of the
   * title: it would put the same words on the page twice.
   */
  message,
}: {
  title?: string;
  message?: string;
} = {}) {
  const { pathname } = useLocation();
  const identity = useMemo(() => parsePathIdentity(pathname), [pathname]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LookupResults | null>(null);
  const [searching, setSearching] = useState(false);
  // The identity the current results were found for — free-text results are
  // ranked against what was typed, path results against the dead path.
  const [rankBy, setRankBy] = useState<PathIdentity>(identity);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    document.title = "GlideComp - Page not found";
  }, []);

  useEffect(() => {
    const typed = query.trim();
    const params = typed ? freeTextParams(typed) : lookupParams(identity);
    const forIdentity: PathIdentity = typed
      ? { comp: { id: "", slug: typed }, task: { id: "", slug: typed }, pilot: { id: "", slug: typed } }
      : identity;
    if (!params) {
      setResults(null);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);
    // Only a typed query needs the pause; the path is already known on arrival.
    const delay = typed ? SEARCH_DEBOUNCE_MS : 0;
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetchWithRetry(() =>
            fetch(`/api/comp/lookup?${params.toString()}`, { credentials: "include" })
          );
          if (cancelled) return;
          // A failed lookup is not a finding — the page below still works, so
          // there is nothing to report beyond having no suggestions.
          setResults(res.ok ? ((await res.json()) as LookupResults) : EMPTY);
          setRankBy(forIdentity);
        } catch {
          if (!cancelled) setResults(EMPTY);
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, delay);

    return () => {
      cancelled = true;
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [identity, query]);

  const suggestions: Suggestion[] = useMemo(
    () => (results ? buildSuggestions(rankBy, results) : []),
    [rankBy, results]
  );

  const searched = results !== null;
  const typed = query.trim().length > 0;

  return (
    // A div, not a <main>: every route that renders this sits inside Shell's
    // <main id="main-content">, and a nested landmark gives assistive tech two
    // "main" regions to choose between.
    <div className="mx-auto flex max-w-xl flex-col items-start gap-4 py-12">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="text-muted-foreground">
        {message ??
          "The page you're looking for doesn't exist or may have moved."}{" "}
        Search for it below.
      </p>

      <SearchField
        className="w-full"
        aria-label="Search competitions, tasks and pilots"
        placeholder="Search competitions, tasks and pilots…"
        value={query}
        onChange={setQuery}
      />

      {searching ? (
        <Loading>Searching…</Loading>
      ) : suggestions.length > 0 ? (
        <section aria-labelledby="nf-did-you-mean" className="w-full">
          <h2 id="nf-did-you-mean" className="text-sm font-medium">
            {typed ? "Search results" : "Did you mean…"}
          </h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {suggestions.map((s) => (
              <li key={s.path}>
                <Link to={s.path} className={linkClass}>
                  {s.label}
                </Link>
                {s.context ? (
                  <span className="text-muted-foreground"> · {s.context}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : searched ? (
        <p className="text-sm text-muted-foreground">
          {typed
            ? "Nothing matched that search."
            : "Nothing in the address matched a competition, task or pilot."}
        </p>
      ) : null}
    </div>
  );
}
