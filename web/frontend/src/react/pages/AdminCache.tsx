/** Super-admin KV cache stats + clear — React port of admin-cache.ts/admin-cache.html. */
import { useEffect, useState } from "react";
import { Button } from "@/react/ui/button";
import { useConfirm } from "../lib/confirm";
import { toast } from "../lib/toast";
import { signInWithGoogle, useUser } from "../lib/user";

interface NamespaceStats {
  name: string;
  item_count: number;
  by_prefix: Record<string, number>;
}

interface CacheStats {
  total_items: number;
  namespaces: NamespaceStats[];
}

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
  const confirm = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | LoadResult>({ kind: "loading" });
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    document.title = "GlideComp - Admin: Cache";
  }, []);

  useEffect(() => {
    if (userLoading) return;
    if (!user) {
      signInWithGoogle();
      return;
    }
    let cancelled = false;
    loadStats().then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

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
            Materialized scores in D1, the KV replay-bundle cache, and the
            AirScore proxy cache
          </p>
        </div>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="shrink-0"
          disabled={clearing}
          onClick={handleClear}
        >
          Clear entire cache
        </Button>
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

      <p className="mt-6 text-sm text-muted-foreground" role="status" aria-live="polite">
        {clearing ? "Clearing…" : ""}
      </p>
    </section>
  );
}
