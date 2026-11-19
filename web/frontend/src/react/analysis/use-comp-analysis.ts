/**
 * The comp analysis, fetched once for whichever page shows it.
 *
 * `/comp/:id/analysis` and the page for one behaviour under it
 * (`/analysis/behaviour/:metric`) read the same body: the aggregate of every
 * class. This is that fetch, lifted out of the page when the second reader
 * arrived, so the two cannot disagree about a retry, a 404 or the poll.
 *
 * SSR seed: the server ran loadCompAnalysis for the URL and embedded the
 * result. It is null on client boot and on in-app navigation, where the
 * effect fetches.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { idFromSegment } from "../lib/slug";
import { usePollWhile } from "../lib/use-poll-while";
import { useInitialData } from "../lib/initial-data";
import { api } from "../../comp/api";
import type { CompAnalysisLoaderData } from "../loaders";
import { fetchWithRetry, type CompDetailData } from "../comp/types";
import type { CompAnalysisData } from "./types";

export type CompAnalysisStatus = "loading" | "ready" | "notFound" | "forbidden" | "error";

export function useCompAnalysis() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");

  // SSR seed: the server ran loadCompAnalysis for this URL and embedded
  // the result. Null on client boot / SPA navigations, where the effect fetches.
  const initial = useInitialData<CompAnalysisLoaderData>();
  const [data, setData] = useState<CompAnalysisData | null>(
    initial?.analysis ?? null
  );
  const [etag, setEtag] = useState<string | null>(initial?.analysisEtag ?? null);
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [status, setStatus] = useState<CompAnalysisStatus>(
    initial ? "ready" : "loading"
  );

  const analysisUrl = compId
    ? `/api/comp/${encodeURIComponent(compId)}/analysis`
    : null;

  // refetchTick > 0 re-runs the fetch without flashing the loading state —
  // the pending-poll effect below bumps it while tasks compute in the
  // background.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!compId || !analysisUrl) return;
    // Seeded by SSR for the first render — don't refetch on mount, but the
    // pending-poll effect below still drives refetches (refetchTick > 0).
    if (initial && refetchTick === 0) {
      document.title = `GlideComp - Comp analysis: ${initial.analysis.comp_name}`;
      return;
    }
    let cancelled = false;
    (async () => {
      if (refetchTick === 0) setStatus("loading");
      try {
        // Through fetchWithRetry, not a bare fetch: this page is public and
        // SSR'd, and its "error" branch is a dead end — nothing re-fetches it
        // (the pending poll below only runs once status is "ready"). A dropped
        // request would otherwise turn a millisecond blip into a page that
        // stays broken until someone reloads by hand.
        const res = await fetchWithRetry(() =>
          fetch(analysisUrl, { credentials: "include" })
        );
        if (cancelled) return;
        // 404 = missing (or a test comp hidden from this visitor); 400 = an id
        // sqid that doesn't decode at all. Both mean "no such page", and both
        // are a dead id rather than a permissions verdict — the API never 401s
        // here (routes/analysis.ts). Worth telling apart, because the 404
        // page can rebuild the URL from its own slugs and "may not be published
        // yet" cannot. Same rule as loaders.ts and PilotScoreDetail.
        if (res.status === 404 || res.status === 400) {
          setStatus("notFound");
          return;
        }
        if (res.status === 401) {
          setStatus("forbidden");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        setEtag(res.headers.get("ETag"));
        const body = (await res.json()) as CompAnalysisData;
        setData(body);
        document.title = `GlideComp - Comp analysis: ${body.comp_name}`;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL; compId is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, analysisUrl, refetchTick]);

  // While any task's first analysis computes in the background, refetch so
  // the aggregate fills in as reports land — same poll the task page runs.
  const pendingTasks = status === "ready" && (data?.pending_task_count ?? 0) > 0;
  usePollWhile(pendingTasks, () => setRefetchTick((t) => t + 1), refetchTick);

  useEffect(() => {
    if (!compId) return;
    // SSR already seeded the comp (name + timezone); skip the cosmetic fetch.
    if (initial?.comp) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].$get({ param: { comp_id: compId } });
        if (!cancelled && res.ok) {
          setComp((await res.json()) as unknown as CompDetailData);
        }
      } catch {
        // Cosmetic only.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId]);

  return {
    compId,
    data,
    etag,
    comp,
    status,
    analysisUrl,
    /** The competition's name, known from the analysis before the comp loads. */
    canonicalName: comp?.name ?? data?.comp_name,
  };
}
