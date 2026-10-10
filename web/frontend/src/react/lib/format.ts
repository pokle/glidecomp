// The pure formatters moved to @glidecomp/client so the app formats the same
// way (mobile plan, stage 2). Re-exported here so the website's imports do not
// change; only the DOM-bound download stays.
export * from "@glidecomp/client/format";

export function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
