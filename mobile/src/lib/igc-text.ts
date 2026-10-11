import { gunzipSync, strFromU8 } from 'fflate';

/**
 * A downloaded tracklog's bytes as IGC text. Tracklogs are stored gzipped and
 * served with `Content-Encoding: gzip`, which the platform's HTTP stack
 * normally undoes. Check the magic bytes rather than trust it, as the website
 * does: a proxy that strips the header hands over the compressed bytes as
 * they are.
 */
export function igcText(bytes: Uint8Array): string {
  const gzipped = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  return strFromU8(gzipped ? gunzipSync(bytes) : bytes, true);
}
