/**
 * Shared types + helpers for the React comp detail / task detail pages.
 *
 * The API wire types and `fetchWithRetry` moved to @glidecomp/client, which
 * the app shares (mobile plan, stage 2); they are re-exported here so the
 * website's imports do not change. What stays is browser-only.
 */
export * from "@glidecomp/client/types";
export { fetchWithRetry } from "@glidecomp/client/retry";
export { isPastCloseDate } from "@glidecomp/client/format";

export async function compressIgc(file: File): Promise<ArrayBuffer> {
  const stream = file.stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Relative time for audit entries, switching to a plain date after 30 days. */
export function formatAuditTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
