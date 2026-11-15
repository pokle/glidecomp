/** Super-admin KV cache stats + clear — React port of admin-cache.ts/admin-cache.html. */
import { useEffect, useState } from "react";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { Loading, Spinner } from "@/react/rac/progress";
import { useConfirm } from "../lib/confirm";
import { underSettings } from "../lib/crumbs";
import { toast } from "../lib/toast";
import { useGoToSignIn, useUser } from "../lib/user";
import { Card } from "@/react/rac/card";

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

  // The two things this page can do, under ⋯ — only once the stats have
  // loaded, which is also the proof that this reader may do them. While one
  // runs the bar says so, and neither can be started again.
  const busy = clearing || reindexing;
  const actions: BarAction[] =
    state.kind === "ready"
      ? [
          {
            id: "reindex",
            label: "Rebuild search index",
            onAction: () => void handleReindex(),
            disabled: busy,
          },
          {
            id: "clear",
            label: "Clear entire cache",
            onAction: () => void handleClear(),
            destructive: true,
            group: true,
            disabled: busy,
          },
        ]
      : [];
  const bar = (
    <PageBar
      title="Cache"
      trail={underSettings()}
      actions={actions}
      status={
        clearing ? (
          <Spinner label="Clearing the cache" />
        ) : reindexing ? (
          <Spinner label="Rebuilding the search index" />
        ) : undefined
      }
    />
  );

  if (userLoading || state.kind === "loading") {
    return (
      <Page bar={bar}>
        <Loading>Loading cache stats…</Loading>
      </Page>
    );
  }

  if (state.kind === "error") {
    return (
      <Page bar={bar}>
        <p className="text-sm text-muted-foreground" role="alert">
          {state.message}
        </p>
      </Page>
    );
  }

  const { stats } = state;

  return (
    <Page bar={bar}>
      <p className="mb-6 text-sm text-muted-foreground">
        Materialised scores in D1, the search index, the KV replay-bundle cache, and the
        AirScore proxy cache
      </p>

      <Card className="mb-6 gap-1">
        <p className="text-sm text-muted-foreground">Total items</p>
        <p className="text-3xl font-bold tracking-tight">{stats.total_items}</p>
      </Card>

      <div className="space-y-4">
        {stats.namespaces.map((ns) => (
          <Card key={ns.name} className="gap-2">
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
          </Card>
        ))}
      </div>
    </Page>
  );
}
