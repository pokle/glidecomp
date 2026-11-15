/**
 * Small shared pieces for the prototype's pages (/proto).
 */
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { GridList, GridListItem, RowContent } from "@/react/rac/grid-list";
import { openedHere } from "../lib/leave";
import { toast } from "../lib/toast";

export interface LinkRow {
  id: string;
  title: string;
  detail?: string;
  /** Right of the name: a figure, a current value. */
  value?: string;
  to: string;
}

/**
 * A list of rows that each open a page. The whole row is the target, and the
 * page it opens is marked as opened from here, so its back button is a real
 * Back (lib/leave.ts).
 */
export function LinkRows({
  label,
  rows,
  empty = "Nothing here.",
}: {
  label: string;
  rows: LinkRow[];
  empty?: string;
}) {
  const navigate = useNavigate();
  return (
    <GridList
      aria-label={label}
      variant="rows"
      items={rows}
      onAction={(key) => {
        const row = rows.find((r) => r.id === key);
        if (row) void navigate(row.to, openedHere());
      }}
      renderEmptyState={() => (
        <p className="p-6 text-center text-sm text-muted-foreground">{empty}</p>
      )}
    >
      {(row) => (
        // The scroll margin keeps a row reached by keyboard out from under
        // the bar and whatever sticks with it (WCAG 2.4.11).
        <GridListItem
          variant="rows"
          id={row.id}
          textValue={row.title}
          className="cursor-pointer scroll-mt-32"
        >
          <RowContent
            title={row.title}
            detail={row.detail}
            action={
              row.value ? (
                <span className="shrink-0 text-muted-foreground tabular-nums">{row.value}</span>
              ) : undefined
            }
            chevron
          />
        </GridListItem>
      )}
    </GridList>
  );
}

/** A titled block of a page. */
export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

/** An action the prototype does not build: it only says it was pressed. */
export function stub(label: string): () => void {
  return () => toast.info(`${label}: not part of the prototype`);
}
