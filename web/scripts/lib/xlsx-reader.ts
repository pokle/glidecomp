// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * A very small read-only .xlsx reader: enough to turn one worksheet into a
 * grid of strings, and no more.
 *
 * This exists because the CIVL rankings export (see
 * `web/scripts/fetch-civl-rankings.ts`) is only available as .xlsx — the
 * export endpoint accepts `format=csv` and returns a spreadsheet anyway — and
 * the repo has no spreadsheet dependency. The files in question are trivial:
 * one sheet, no formulas, no styles that change a value's meaning, written by
 * LibreOffice with every string inline. Pulling in exceljs or SheetJS to read
 * that is a poor trade, so this reads it directly, the same way
 * `web/frontend/src/react/comp/csv.ts` hand-rolls CSV rather than taking a
 * parser.
 *
 * What it deliberately DOES handle, despite CIVL not currently needing it:
 *
 *   * shared strings (`t="s"` + xl/sharedStrings.xml) as well as inline
 *     strings. If CIVL ever changes the writer behind their export, the
 *     failure mode of not handling this is a table full of blank pilot names
 *     that looks like a successful import.
 *   * cell references (`r="B7"`). Writers omit empty cells, so reading cells
 *     positionally shifts every value after a gap into the wrong column — and
 *     the CIVL metadata header is exactly that shape (values in A, C, E, G, I
 *     with B, D, F, H empty).
 *   * row references, so `rows[n - 1]` is always spreadsheet row n. The CIVL
 *     sheet skips rows 3 and 4 entirely.
 *
 * What it does NOT do: dates (returns the raw serial number), number
 * formatting, formulas (returns the cached value), multiple sheets, or writing.
 */

import { inflateRawSync } from 'node:zlib';

// --- zip container ---------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Read the entries of a zip archive into `name -> bytes`.
 *
 * Sizes and offsets come from the CENTRAL directory, never from the local
 * headers: an archive written in streaming mode leaves the local header's
 * sizes as zero and puts the real ones in a trailing data descriptor, so a
 * local-header reader silently extracts empty files.
 */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (off: number) => view.getUint32(off, true);
  const u16 = (off: number) => view.getUint16(off, true);

  // The end-of-central-directory record is last, but a zip comment may follow
  // it, so scan backwards for the signature. 22 bytes is its fixed size.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip archive (no end-of-central-directory record)');

  const entryCount = u16(eocd + 10);
  let ptr = u32(eocd + 16); // offset of the first central-directory entry

  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < entryCount; i++) {
    if (u32(ptr) !== CDIR_SIG) throw new Error(`Corrupt zip: bad central directory entry ${i}`);
    const method = u16(ptr + 10);
    const compressedSize = u32(ptr + 20);
    const nameLen = u16(ptr + 28);
    const extraLen = u16(ptr + 30);
    const commentLen = u16(ptr + 32);
    const localOffset = u32(ptr + 42);
    const name = new TextDecoder().decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry

    // The local header's extra field can differ in length from the central
    // one's, so the data offset has to be read from the local header.
    if (u32(localOffset) !== LOCAL_SIG) throw new Error(`Corrupt zip: bad local header for ${name}`);
    const dataStart = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`Unsupported zip compression method ${method} for ${name}`);
  }
  return out;
}

// --- xml ------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Resolve XML entities, including the numeric forms LibreOffice emits. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/**
 * Match one element, capturing its attributes and (for a non-empty element)
 * its body. The attribute group is LAZY and the self-closing branch comes
 * first for a reason: a greedy `[^>]*` happily eats the `/` of `<c r="B1"/>`,
 * after which the `>` branch matches and the "body" runs on to the next
 * `</c>` — silently swallowing the following cell. That bug reads as "CIVL
 * moved a column", so it is worth the awkward pattern.
 */
function elementRegex(tag: string): RegExp {
  return new RegExp(`<${tag}(\\s[^>]*?)?\\s*(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
}

/** Concatenated text of every `<t>` in a fragment (a run-formatted cell has several). */
function textOf(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(elementRegex('t'))) {
    out += decodeEntities(m[2] ?? '');
  }
  return out;
}

/** `"B7"` -> 1. Column letters are base-26 with A=1. */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break; // stop at the row digits
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

// --- sheet ----------------------------------------------------------------

/**
 * Read a worksheet as a grid of strings.
 *
 * The result is padded so that `rows[n - 1][c]` is spreadsheet row `n`, column
 * `c` (0-based), with `''` for every cell the file omits. Both dimensions are
 * ragged only at the end — a row is as long as its last non-empty cell.
 *
 * @param sheetName which sheet to read, by 1-based position (default: the first)
 */
export function readSheetRows(bytes: Uint8Array, sheetNumber = 1): string[][] {
  const files = unzip(bytes);

  const sheetPath = `xl/worksheets/sheet${sheetNumber}.xml`;
  const sheetBytes = files.get(sheetPath);
  if (!sheetBytes) {
    throw new Error(`Workbook has no ${sheetPath} (entries: ${[...files.keys()].join(', ')})`);
  }
  const xml = new TextDecoder().decode(sheetBytes);

  // Shared strings are indexed by position; absent from files that inline them.
  const sharedBytes = files.get('xl/sharedStrings.xml');
  const shared: string[] = [];
  if (sharedBytes) {
    const sxml = new TextDecoder().decode(sharedBytes);
    for (const m of sxml.matchAll(elementRegex('si'))) shared.push(textOf(m[2] ?? ''));
  }

  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(elementRegex('row'))) {
    const attrs = rowMatch[1] ?? '';
    const body = rowMatch[2] ?? '';
    const rowNum = Number(attrs.match(/\sr="(\d+)"/)?.[1] ?? rows.length + 1);
    while (rows.length < rowNum - 1) rows.push([]);

    const cells: string[] = [];
    let nextCol = 0;
    for (const cellMatch of body.matchAll(elementRegex('c'))) {
      const cAttrs = cellMatch[1] ?? '';
      const cBody = cellMatch[2] ?? '';
      const ref = cAttrs.match(/\sr="([A-Z]+)\d+"/)?.[1];
      const col = ref ? columnIndex(ref) : nextCol;
      const type = cAttrs.match(/\st="([^"]+)"/)?.[1];

      let value: string;
      if (type === 'inlineStr') {
        value = textOf(cBody);
      } else if (type === 's') {
        const idx = Number(cBody.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '-1');
        value = shared[idx] ?? '';
      } else {
        // Numbers, booleans, dates (raw serial) and formula results all land
        // in <v>; `str` cells hold a formula's string result there too.
        value = decodeEntities(cBody.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? '');
      }

      while (cells.length < col) cells.push('');
      cells[col] = value;
      nextCol = col + 1;
    }
    rows.push(cells);
  }
  return rows;
}
