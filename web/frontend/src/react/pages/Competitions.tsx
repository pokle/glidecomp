/**
 * Competition list + site search. The bar has + and, sticking with it, the
 * search field (the pilots page's layout). Starting a new competition is a page of its
 * own (/comp/new, pages/NewCompPage.tsx). Built on the RAC kit
 * (src/react/rac/) — see docs/2026-07-18-rac-adoption-guide.md.
 *
 * The one box does two different jobs, and the boundary between them is the
 * number of characters typed:
 *
 * - **Under two characters** it filters the list already on the page, which is
 *   instant and needs no network. This is also the state the page is rendered
 *   in on the server, so an empty query hydrates against identical markup.
 * - **From two characters** it searches the whole site — competitions, tasks,
 *   their routes and pilots — via GET /api/comp/search, and the flat list is
 *   replaced by the comp → task → pilot hierarchy the matches live in. That is
 *   how "elliot KANGCK" finds the tasks that fly through both turnpoints
 *   without anyone naming the competition.
 *
 * The query is mirrored into `?q=` so a search is a link someone can send. The
 * SSR Pages Function serves that URL as the plain shell (noindex): search
 * results are fetched client-side, and the list below is hidden while they
 * show, so there is nothing for the server to render either way.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";
import { Link as AriaLink, useFilter } from "react-aria-components";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { cardSurface } from "@/react/rac/card";
import { cn } from "@/react/lib/utils";
import { SearchField } from "@/react/rac/field";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import {
  formatDate,
  formatTaskDateRange,
  categoryLabel,
  scoringFormatLabel,
} from "../lib/format";
import { useInitialData } from "../lib/initial-data";
import { compPath, compUrlId, newCompPath } from "../lib/slug";
import { SearchResults } from "../search/SearchResults";
import { MIN_SEARCH_CHARS, useSiteSearch } from "../search/use-site-search";
import type { CompListEntry, CompetitionsLoaderData } from "../loaders";

type Comp = CompListEntry;

export function Competitions() {
  const { previewRole } = useUser();
  // SSR: seed from the server loader so the list is in the first paint and the
  // client hydrates the same markup. Client boot / SPA navigations start null.
  const initial = useInitialData<CompetitionsLoaderData>();
  const [comps, setComps] = useState<Comp[] | null>(initial?.comps ?? null);
  const [loadError, setLoadError] = useState(false);
  // Seeded from the URL during render, not in an effect: the server renders
  // this same location, so both sides start with the same query and the same
  // decision about which of the two views to show.
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const { contains } = useFilter({ sensitivity: "base" });

  const searchState = useSiteSearch(query);
  const searching = query.trim().length >= MIN_SEARCH_CHARS;

  /** Keep `?q=` in step so a search can be linked, without stacking history. */
  function handleQueryChange(next: string) {
    setQuery(next);
    const params = new URLSearchParams(searchParams);
    if (next.trim()) params.set("q", next);
    else params.delete("q");
    setSearchParams(params, { replace: true });
  }

  useEffect(() => {
    document.title = "GlideComp - Competitions";
    // Already seeded from SSR — skip the redundant initial fetch.
    if (initial) return;
    (async () => {
      try {
        const res = await api.api.comp.$get();
        if (!res.ok) {
          setLoadError(true);
          return;
        }
        const data = await res.json();
        setComps(data.comps as unknown as Comp[]);
      } catch {
        setLoadError(true);
      }
    })();
    // Seeding is a first-render concern; re-running on `initial` identity is
    // unnecessary (it never changes for a given mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The API returns test comps to their admins; when a superadmin previews a
  // lower role, hide them like the API would for that role.
  const visibleComps =
    comps === null
      ? null
      : previewRole === "out" || previewRole === "pilot"
        ? comps.filter((c) => !c.test)
        : comps;

  // Client-side filter for the short-query case: every query word must match
  // somewhere in the comp's name or its meta line (wing / scoring format /
  // classes). Matching is locale-aware and accent/case-insensitive (useFilter
  // sensitivity "base"). An empty query renders the full list — which keeps
  // the SSR markup identical at hydration. From MIN_SEARCH_CHARS up, the
  // server-side search replaces this view entirely.
  const words = useMemo(() => query.trim().split(/\s+/).filter(Boolean), [query]);
  const filteredComps =
    visibleComps === null || words.length === 0
      ? visibleComps
      : visibleComps.filter((comp) => {
          const haystack = [
            comp.name,
            categoryLabel(comp.category),
            scoringFormatLabel(comp.scoring_format),
            comp.pilot_classes.join(" "),
          ].join(" ");
          return words.every((word) => contains(haystack, word));
        });

  return (
    <Page
      bar={
        // The + is the same link for everyone: /comp/new offers a signed-out
        // reader sign-in itself, and coming back from it lands them on the
        // form they asked for. It also means the server and the client render
        // the same bar, so nothing swaps in once the user resolves.
        <PageBar
          title="Competitions"
          add={{ label: "Start a new competition", to: newCompPath() }}
          below={
            <SearchField
              variant="floating"
              aria-label="Search competitions, tasks, pilots and turnpoints"
              placeholder="Search comps, tasks, pilots, turnpoints…"
              value={query}
              onChange={handleQueryChange}
            />
          }
        />
      }
    >
      {/* Announce filter results to screen readers as the list narrows. The
          search view has its own live region — see SearchResults. */}
      <p role="status" className="sr-only">
        {!searching && words.length > 0 && filteredComps !== null && visibleComps !== null
          ? `${filteredComps.length} of ${visibleComps.length} competitions shown`
          : ""}
      </p>

      {/* The scroll margin keeps a link reached by keyboard out from under
          the bar and the search field that sticks with it: WCAG 2.4.11,
          Focus Not Obscured. */}
      <div className="[&_a]:scroll-mt-32">
        {searching ? (
          <SearchResults state={searchState} query={query} />
        ) : loadError ? (
          <p role="alert">
            Failed to load competitions. Please reload the page.
          </p>
        ) : filteredComps === null ? (
          <Loading>Loading competitions…</Loading>
        ) : filteredComps.length === 0 ? (
          <p className="text-muted-foreground">
            {words.length > 0
              ? `No competitions match “${query.trim()}”.`
              : "No competitions found"}
          </p>
        ) : (
          <ul className="space-y-2.5">
            {filteredComps.map((comp) => (
              <li key={comp.comp_id}>
                <AriaLink
                  href={compPath(compUrlId(comp, comp.comp_id), comp.name)}
                  className={cn(
                    cardSurface,
                    "flex items-center gap-3 px-4 py-3 transition-colors outline-none data-hovered:bg-muted data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50"
                  )}
                >
                  {/* The facts wrap among themselves; the chevron stays at the
                      card's right edge, as on every row that opens a page. */}
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <span>
                      <span className="block font-semibold">
                        {comp.name}
                        {comp.test ? (
                          <span className="ml-2 inline-flex items-center rounded-full border px-2 py-0.5 align-middle text-xs font-medium text-muted-foreground">
                            Hidden
                          </span>
                        ) : null}
                      </span>
                      <span className="block text-sm text-muted-foreground">
                        {[
                          categoryLabel(comp.category),
                          scoringFormatLabel(comp.scoring_format),
                          comp.pilot_classes.join(", "),
                        ].join(" · ")}
                      </span>
                    </span>
                    <span className="ml-auto text-sm whitespace-nowrap text-muted-foreground">
                      {comp.first_task_date && comp.last_task_date
                        ? formatTaskDateRange(comp.first_task_date, comp.last_task_date)
                        : `created ${formatDate(comp.creation_date)}`}
                    </span>
                  </span>
                  <ChevronRightIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                </AriaLink>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Page>
  );
}
