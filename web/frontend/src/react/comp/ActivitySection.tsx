/**
 * Activity (audit log) section — React port of setupActivitySection().
 * Uses plain fetch (not the Hono RPC client) to keep the response shape
 * simple, with filter tabs (RAC kit) and cursor-based load-more.
 */
import { useEffect, useState } from "react";
import { Button } from "@/react/rac/button";
import { Tabs, TabList, Tab, TabPanel } from "@/react/rac/tabs";
import { formatAuditTime, type AuditEntry, type AuditResponse } from "./types";

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "pilot", label: "Pilots" },
  { value: "track", label: "Tracks" },
  { value: "comp", label: "Settings" },
];

// RAC tab keys can't be "" (falsy keys confuse selection) — the All filter
// rides on a sentinel key that maps back to the empty subject_type filter.
const ALL_KEY = "all";

async function fetchAuditPage(
  compId: string,
  filter: string,
  before: number | null
): Promise<AuditResponse | null> {
  const params = new URLSearchParams();
  params.set("limit", "25");
  if (filter) params.set("subject_type", filter);
  if (before !== null) params.set("before", String(before));
  const res = await fetch(`/api/comp/${encodeURIComponent(compId)}/audit?${params}`, {
    credentials: "include",
  });
  if (!res.ok) return null;
  return (await res.json()) as AuditResponse;
}

export function ActivitySection({
  compId,
  collapsible = false,
}: {
  compId: string;
  /**
   * Start as a 3-entry digest with a "Show all activity" control (the comp
   * hub) instead of the full filter-tabs UI. The audit log is the
   * transparency record, so it stays on the page — it just doesn't open at
   * full length between a newcomer and the content below it.
   */
  collapsible?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(!collapsible);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      try {
        const data = await fetchAuditPage(compId, filter, null);
        if (cancelled) return;
        if (data === null) {
          setError(true);
          setEntries([]);
          setHasMore(false);
        } else {
          setError(false);
          setEntries(data.entries);
          setNextBefore(data.next_before);
          setHasMore(data.has_more);
        }
        setLoaded(true);
      } catch {
        // Silent — activity is non-critical
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, filter]);

  async function loadMore() {
    try {
      const data = await fetchAuditPage(compId, filter, nextBefore);
      if (data === null) return;
      setEntries((prev) => [...prev, ...data.entries]);
      setNextBefore(data.next_before);
      setHasMore(data.has_more);
    } catch {
      // Silent — activity is non-critical
    }
  }

  const selectedKey = filter === "" ? ALL_KEY : filter;

  // Collapsed digest: the 3 most recent entries + the control to expand into
  // the full filterable log.
  if (!expanded) {
    const digest = entries.slice(0, 3);
    return (
      <section>
        <h2 className="mt-8 text-lg font-bold">Activity</h2>
        {error ? (
          <p className="mt-2 text-muted-foreground">Could not load activity</p>
        ) : loaded && entries.length === 0 ? (
          <p className="mt-2 text-muted-foreground">No activity yet</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {digest.map((entry) => (
              <li key={entry.audit_id}>
                <span className="text-muted-foreground">
                  {formatAuditTime(entry.timestamp)}
                </span>{" "}
                <strong>{entry.actor_name}</strong> <span>{entry.description}</span>
              </li>
            ))}
          </ul>
        )}
        {/* Always offered once loaded (not only when truncated): the full
            view also carries the filter tabs. */}
        {!error && loaded ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onPress={() => setExpanded(true)}
          >
            Show all activity
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">Activity</h2>
      <Tabs
        className="mt-2"
        selectedKey={selectedKey}
        onSelectionChange={(key) => setFilter(key === ALL_KEY ? "" : String(key))}
      >
        <TabList aria-label="Activity filter">
          {FILTERS.map((f) => (
            <Tab key={f.value} id={f.value === "" ? ALL_KEY : f.value}>
              {f.label}
            </Tab>
          ))}
        </TabList>
        {/* One shared panel: its id always matches the active tab. */}
        <TabPanel id={selectedKey}>
          {error ? (
            <p className="text-muted-foreground">Could not load activity</p>
          ) : loaded && entries.length === 0 ? (
            <p className="text-muted-foreground">No activity yet</p>
          ) : (
            <ul className="space-y-1">
              {entries.map((entry) => (
                <li key={entry.audit_id}>
                  <span className="text-muted-foreground">
                    {formatAuditTime(entry.timestamp)}
                  </span>{" "}
                  <strong>{entry.actor_name}</strong> <span>{entry.description}</span>
                </li>
              ))}
            </ul>
          )}
          {hasMore ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onPress={() => void loadMore()}
            >
              Load more
            </Button>
          ) : null}
        </TabPanel>
      </Tabs>
    </section>
  );
}
