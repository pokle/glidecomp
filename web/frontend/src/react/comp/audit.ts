/**
 * The activity log (`GET /api/comp/:comp_id/audit`): its filters, the query
 * a page of it is asked with, and its entries grouped by day. Pure, so the
 * Activity section's rules are unit-testable.
 */
import type { AuditEntry } from "./types";

/** A filter's `subject_type`, or "" for every entry. */
export type ActivityFilter = "" | AuditEntry["subject_type"];

/** The filters, in the order the Activity section shows them (IA §12). */
export const ACTIVITY_FILTERS: { value: ActivityFilter; label: string }[] = [
  { value: "", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "pilot", label: "Pilots" },
  { value: "track", label: "Tracks" },
  { value: "comp", label: "Settings" },
];

/** Entries per page: enough to fill a phone screen twice. */
export const ACTIVITY_PAGE_SIZE = 25;

/** The query string for one page, older than `before` when paging on. */
export function activityQuery(filter: ActivityFilter, before: number | null): Record<string, string> {
  const query: Record<string, string> = { limit: String(ACTIVITY_PAGE_SIZE) };
  if (filter) query.subject_type = filter;
  if (before !== null) query.before = String(before);
  return query;
}

export interface ActivityDay {
  /** YYYY-MM-DD in the competition's zone. */
  date: string;
  entries: AuditEntry[];
}

/**
 * Entries grouped by the day they happened on in `timeZone` — the
 * competition's, so an organiser's late-evening change lands on the day the
 * comp lived it, whoever is reading. Keeps the server's order (newest first)
 * within and across days.
 */
export function groupActivityByDay(entries: readonly AuditEntry[], timeZone: string | null): ActivityDay[] {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const days: ActivityDay[] = [];
  for (const entry of entries) {
    const at = new Date(entry.timestamp);
    const date = Number.isNaN(at.getTime()) ? entry.timestamp.slice(0, 10) : day.format(at);
    const last = days[days.length - 1];
    if (last && last.date === date) last.entries.push(entry);
    else days.push({ date, entries: [entry] });
  }
  return days;
}
