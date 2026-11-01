/**
 * The roster as a LIST — one row per pilot, each opening that pilot's sheet
 * (comp/PilotSheet.tsx), at every width.
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
 */
import { GridList, GridListItem, RowContent } from "@/react/rac/grid-list";
import type { CompPilot } from "./csv";

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
  emptyMessage,
  onOpen,
}: {
  pilots: CompPilot[];
  /** Why the list is empty — "nobody yet" and "nobody matches" differ. */
  emptyMessage: string;
  onOpen: (compPilotId: string) => void;
}) {
  return (
    <GridList
      aria-label="Pilots"
      variant="rows"
      items={pilots.map((p) => ({ ...p, id: p.comp_pilot_id }))}
      onAction={(key) => onOpen(String(key))}
      renderEmptyState={() => (
        <p className="p-6 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      )}
    >
      {(p) => (
        <GridListItem variant="rows" id={p.id} textValue={p.name} className="cursor-pointer">
          <RowContent title={p.name} detail={pilotDetail(p)} chevron />
        </GridListItem>
      )}
    </GridList>
  );
}
