/**
 * Activity (audit log) section — React port of setupActivitySection().
 * Uses plain fetch (not the Hono RPC client) to keep the response shape
 * simple, with filter tabs and cursor-based load-more.
 */
import { useEffect, useState } from "react";
import { Button } from "@/react/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/react/ui/tabs";
import { formatAuditTime, type AuditEntry, type AuditResponse } from "./types";

const FILTERS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "task", label: "Tasks" },
  { value: "pilot", label: "Pilots" },
  { value: "track", label: "Tracks" },
  { value: "comp", label: "Settings" },
];

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

export function ActivitySection({ compId }: { compId: string }) {
  const [filter, setFilter] = useState("");
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);

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

  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">Activity</h2>
      <Tabs
        className="mt-2"
        value={filter}
        onValueChange={(v) => setFilter(v as string)}
      >
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* One shared panel: its value always matches the active tab. */}
        <TabsContent value={filter}>
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
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void loadMore()}
            >
              Load more
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </section>
  );
}
