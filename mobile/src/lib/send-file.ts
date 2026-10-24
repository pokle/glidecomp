/**
 * Handing a task or waypoint file to the share sheet: AirDrop, Files, or
 * straight into an instrument's app. The file is written to the cache under
 * the name the website would give it (`instrumentFile` in
 * @glidecomp/client), so an instrument sees the same file either way.
 */
import type { InstrumentFile } from '@glidecomp/client/instrument';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * iOS picks the apps a share sheet offers by type. GPX and KML have types of
 * their own that flight apps claim; the rest are only extensions, so they go
 * as plain data and the receiving app reads the extension.
 */
const UTI_BY_EXTENSION: Record<string, string> = {
  gpx: 'com.topografix.gpx',
  kml: 'com.google.earth.kml',
  csv: 'public.comma-separated-values-text',
};

export function utiFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return UTI_BY_EXTENSION[ext] ?? 'public.data';
}

export async function shareFile(file: InstrumentFile, title: string): Promise<void> {
  const out = new File(Paths.cache, file.filename);
  if (out.exists) out.delete();
  out.create();
  out.write(file.text);
  await Sharing.shareAsync(out.uri, { mimeType: file.mimeType, UTI: utiFor(file.filename), dialogTitle: title });
}

/** A file that is already bytes (a library track), shared the same way. */
export async function shareBytes(bytes: Uint8Array, filename: string, title: string): Promise<void> {
  const out = new File(Paths.cache, filename);
  if (out.exists) out.delete();
  out.create();
  out.write(bytes);
  await Sharing.shareAsync(out.uri, { mimeType: 'application/octet-stream', UTI: utiFor(filename), dialogTitle: title });
}
