/**
 * How long ago something was seen, in words: "just now", "4 minutes ago",
 * "2 hours ago", "3 days ago". For the stale banner, where the reader needs
 * to judge whether what they are reading is still the day's latest.
 */
export function ago(thenMs: number, nowMs: number = Date.now()): string {
  const minutes = Math.floor((nowMs - thenMs) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
