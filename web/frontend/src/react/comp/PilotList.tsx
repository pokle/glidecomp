/**
 * The roster as a LIST — one row per pilot, each opening that pilot's own
 * page (pages/CompPilotPage.tsx), at every width.
 *
 * It replaced a fourteen-column Tabulator grid in a dialog. On a phone that
 * grid froze its ✕ and name columns at 176px, more than half the screen, and
 * scrolled the other twelve sideways through what was left: about one and a
 * half columns at a time, with the delete button the easiest thing to hit.
 * The grid went at every width rather than below a breakpoint, for the same
 * reason the waypoints grid did (comp/WaypointList.tsx): two editors are two
 * code paths, and a reviewer at a desk sees the one the author never tried on
 * a phone. Spreadsheet work goes to a spreadsheet — Export CSV, edit, Import
 * CSV — which is better at it than any grid in a browser.
 *
 * A row says what an organiser scans the roster for: the name, then class ·
 * glider · WPRS points, then whether the pilot's tracks can find them —
 * `@username` when an account is linked, "no email" when neither an account
 * nor an email connects them to their uploads.
 *
 * Given `groups` (the page's "Sort: Team"), the same rows sit under a
 * heading per team — "Alpha Gliders · 3 pilots", the teamless last under
 * "No team" — as named groups a screen reader announces. The groups are a
 * sort with headings, not a second list: the same rows, opening the same
 * sheet.
 */
import { Collection } from "react-aria-components";
import {
  GridList,
  GridListHeader,
  GridListItem,
  GridListSection,
  RowContent,
} from "@/react/rac/grid-list";
import type { CompPilot } from "./csv";
import type { TeamGroup } from "./team-names";

/** The facts on a row's second line, in reading order. */
export function pilotDetail(p: CompPilot): string {
  const parts: string[] = [p.pilot_class];
  if (p.glider) parts.push(p.glider);
  if (p.wprs_points !== null) parts.push(`${p.wprs_points} pts`);
  if (p.linked && p.linked_username) parts.push(`@${p.linked_username}`);
  else if (!p.linked && !p.email) parts.push("no email");
  return parts.join(" · ");
}

export function PilotList({
  pilots,
  groups,
  emptyMessage,
  onOpen,
}: {
  pilots: CompPilot[];
  /** The same pilots under team headings, when the list is sorted by team. */
  groups?: TeamGroup<CompPilot>[];
  /** Why the list is empty — "nobody yet" and "nobody matches" differ. */
  emptyMessage: string;
  onOpen: (compPilotId: string) => void;
}) {
  const row = (p: CompPilot & { id: string }) => (
    // The scroll margin keeps a row reached by keyboard out from under the
    // sticky search bar (and the site header above it on wider screens):
    // WCAG 2.4.11, Focus Not Obscured.
    <GridListItem
      variant="rows"
      id={p.id}
      textValue={p.name}
      className="cursor-pointer scroll-mt-16 sm:scroll-mt-32"
    >
      <RowContent title={p.name} detail={pilotDetail(p)} chevron />
    </GridListItem>
  );
  const withIds = (list: CompPilot[]) => list.map((p) => ({ ...p, id: p.comp_pilot_id }));
  const shared = {
    "aria-label": "Pilots",
    variant: "rows" as const,
    onAction: (key: React.Key) => onOpen(String(key)),
    renderEmptyState: () => (
      <p className="p-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
    ),
  };

  if (groups) {
    return (
      <GridList
        {...shared}
        // A section's id shares the collection's key space with the pilots'
        // ids, which are Sqids and never hold a colon. No team is named "",
        // so plain "team:" is the teamless group.
        items={groups.map((g) => ({ ...g, id: `team:${g.team ?? ""}` }))}
      >
        {(g) => (
          <GridListSection variant="rows" id={g.id}>
            {/* "Alpha Gliders · 3 pilots": the name is what a reader scans
                for, so it carries the rows' ink and the count stays muted. */}
            <GridListHeader variant="rows">
              <span className="font-medium text-foreground">{g.team ?? "No team"}</span>
              {` · ${g.size} ${g.size === 1 ? "pilot" : "pilots"}`}
            </GridListHeader>
            <Collection items={withIds(g.pilots)}>{row}</Collection>
          </GridListSection>
        )}
      </GridList>
    );
  }

  return (
    <GridList {...shared} items={withIds(pilots)}>
      {row}
    </GridList>
  );
}
