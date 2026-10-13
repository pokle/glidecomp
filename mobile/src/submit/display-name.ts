/**
 * iOS hands over a file:// copy that keeps its own name, so there is nothing
 * to ask; Android's content URIs are display-name.android.ts.
 */
export function displayName(_uri: string): string | null {
  return null;
}
