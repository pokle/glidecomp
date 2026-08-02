/** Super-admin KV cache stats + clear — React port of admin-cache.ts/admin-cache.html. */
import { useEffect, useState } from "react";
import { Button } from "@/react/rac/button";
import { useConfirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import { useGoToSignIn, useUser } from "../lib/user";

interface NamespaceStats {
  name: string;
  item_count: number;
  by_prefix: Record<string, number>;
}

interface CacheStats {
  total_items: number;
  namespaces: NamespaceStats[];
}

/** Reindex requests one button press will make before handing the rest to the
 *  cron. Each rebuilds up to 4000 documents. */
const REINDEX_ROUNDS = 10;

type LoadResult =
  | { kind: "error"; message: string }
  | { kind: "ready"; stats: CacheStats };

async function loadStats(): Promise<LoadResult> {
  try {
    const res = await fetch("/api/admin/cache/stats", { credentials: "include" });
    if (res.status === 403) {
      return { kind: "error", message: "You don't have access to this page." };
    }
    if (!res.ok) {
      return { kind: "error", message: "Failed to load cache stats." };
    }
    return { kind: "ready", stats: (await res.json()) as CacheStats };
  } catch {
    return { kind: "error", message: "Network error loading cache stats." };
  }
}

export function AdminCache() {
  const { user, loading: userLoading } = useUser();
  const goToSignIn = useGoToSignIn();
  const confirm = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | LoadResult>({ kind: "loading" });
  const [clearing, setClearing] = useState(false);
  const [reindexing, setReindexing] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Admin: Cache";
  }, []);

  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      goToSignIn(window.location.pathname);
      return;
    }
    let cancelled = false;
    loadStats().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [user, userLoading, goToSignIn]);

  async function handleClear() {
    const confirmed = await confirm({
      title: "Re-score everything?",
      message:
        "This marks every stored task score stale (they recompute in the background — readers keep getting instant, timestamped scores) and clears the KV and AirScore caches. Nothing goes slow.",
      confirmLabel: "Clear cache",
      destructive: true,
    });
    if (!confirmed) return;

    setClearing(true);
    try {
      const res = await fetch("/api/admin/cache", {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        toast.error("Failed to clear cache.");
        return;
      }
      const data = (await res.json()) as { cleared: number };
      toast.success(`Cleared ${data.cleared} cached item${data.cleared !== 1 ? "s" : ""}.`);

      const result = await loadStats();
      if (result.kind === "ready") setState(result);
    } catch {
      toast.error("Network error clearing cache.");
    } finally {
      setClearing(false);
    }
  }

  /**
   * Rebuild every search document. The index normally keeps itself current
   * (triggers queue the changes, the worker drains the queue), so this is the
   * lever for "search is wrong and I don't know why" — and for finishing a
   * document-format change sooner than the nightly sweep would.
   */
  async function handleReindex() {
    setReindexing(true);
    try {
      // One request rebuilds a bounded number of documents. Repeat with
      // `resume` — which drains what is queued instead of queueing everything
      // again — until the queue is empty or we hit the round cap, whichever
      // comes first. Anything still queued is the hourly cron's job, and the
      // toast says so rather than implying the work is finished.
      let rebuilt = 0;
      let remaining = 0;
      for (let round = 0; round < REINDEX_ROUNDS; round++) {
        const res = await fetch(
          `/api/admin/search/reindex${round === 0 ? "" : "?resume=true"}`,
          { method: "POST", credentials: "include" }
        );
        if (!res.ok) {
          toast.error("Failed to rebuild the search index.");
          return;
        }
        const data = (await res.json()) as { rebuilt: number; remaining: number };
        rebuilt += data.rebuilt;
        remaining = data.remaining;
        if (remaining === 0) break;
      }
      toast.success(
        remaining > 0
          ? `Rebuilt ${rebuilt} documents; ${remaining} queued for the hourly job.`
          : `Rebuilt ${rebuilt} search document${rebuilt !== 1 ? "s" : ""}.`
      );

      const result = await loadStats();
      if (result.kind === "ready") setState(result);
    } catch {
      toast.error("Network error rebuilding the search index.");
    } finally {
      setReindexing(false);
    }
  }

  if (userLoading || state.kind === "loading") {
    return (
      <div className="py-8 animate-pulse space-y-4" role="status" aria-label="Loading cache stats">
        <div className="h-8 w-48 rounded-md bg-muted" />
        <div className="h-32 rounded-lg bg-muted" />
        <span className="sr-only">Loading cache stats…</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-muted-foreground" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  const { stats } = state;

  return (
    <section className="mx-auto w-full max-w-3xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cache</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Materialized scores in D1, the search index, the KV replay-bundle
            cache, and the AirScore proxy cache
          </p>
        </div>
        {/* isPending, not isDisabled + a label swap: the button stays
            focusable while the request is in flight, so focus isn't dumped to
            the body mid-action, and RAC announces the flip. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            isPending={reindexing}
            pendingLabel="Rebuilding the search index"
            onPress={() => void handleReindex()}
          >
            Rebuild search index
          </Button>
          <Button
            variant="destructive"
            size="sm"
            isPending={clearing}
            pendingLabel="Clearing the cache"
            onPress={() => void handleClear()}
          >
            Clear entire cache
          </Button>
        </div>
      </div>

      <div className="mb-6 p-4 rounded-lg border border-border bg-card">
        <p className="text-sm text-muted-foreground">Total items</p>
        <p className="text-3xl font-bold tracking-tight">{stats.total_items}</p>
      </div>

      <div className="space-y-4">
        {stats.namespaces.map((ns) => (
          <div key={ns.name} className="p-4 rounded-lg border border-border bg-card">
            <div className="flex justify-between items-baseline mb-2">
              <h2 className="font-medium">{ns.name}</h2>
              <span className="text-sm text-muted-foreground">
                {ns.item_count} item{ns.item_count !== 1 ? "s" : ""}
              </span>
            </div>
            {Object.entries(ns.by_prefix).length > 0 ? (
              Object.entries(ns.by_prefix)
                .sort(([, a], [, b]) => b - a)
                .map(([label, count]) => (
                  <div key={label} className="flex justify-between py-1 text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span>{count}</span>
                  </div>
                ))
            ) : (
              <p className="text-sm text-muted-foreground italic">Empty</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
