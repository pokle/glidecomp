// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { join } from "node:path";
import { readSheetRows } from "./xlsx-reader";

const SAMPLES = join(import.meta.dir, "../../samples/civl-rankings");

// --- a minimal zip writer, so these tests can build workbooks CIVL doesn't ---
//
// The reader has to cope with shapes the two committed samples don't contain
// (shared strings, stored entries, gaps). Hand-building the container is the
// only way to exercise those without checking in a fixture per case.

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** @param compress false stores entries verbatim (zip method 0) */
function makeZip(files: Record<string, string>, compress = true): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = compress ? new Uint8Array(deflateRawSync(raw)) : raw;
    const nameBytes = enc.encode(name);
    const method = compress ? 8 : 0;

    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const cdirSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, cdirSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function sheet(inner: string): string {
  return `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${inner}</sheetData></worksheet>`;
}

describe("readSheetRows — cell types", () => {
  test("reads inline strings, shared strings and numbers", () => {
    const bytes = makeZip({
      "xl/sharedStrings.xml": `<sst><si><t>shared one</t></si><si><t>shared two</t></si></sst>`,
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>inline</t></is></c>` +
          `<c r="B1" t="s"><v>1</v></c>` +
          `<c r="C1"><v>42.5</v></c>` +
          `</row>`,
      ),
    });
    expect(readSheetRows(bytes)).toEqual([["inline", "shared two", "42.5"]]);
  });

  test("concatenates the runs of a rich-text cell", () => {
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1" t="inlineStr"><is><r><t>Marco</t></r><r><t> Laurenzi</t></r></is></c></row>`,
      ),
    });
    expect(readSheetRows(bytes)[0][0]).toBe("Marco Laurenzi");
  });

  test("decodes named and numeric entities", () => {
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>Piero &amp; Alberini &lt;Trophy&gt;</t></is></c>` +
          `<c r="B1" t="s"><v>0</v></c>` +
          `</row>`,
      ),
      "xl/sharedStrings.xml": `<sst><si><t>Garc&#237;a Gonz&#xE1;lez</t></si></sst>`,
    });
    expect(readSheetRows(bytes)[0]).toEqual([
      "Piero & Alberini <Trophy>",
      "García González",
    ]);
  });
});

describe("readSheetRows — layout", () => {
  test("a self-closing cell does not swallow the next one", () => {
    // The CIVL metadata header is exactly this shape: values in A, C, E, G, I
    // with empty styled cells between. Getting it wrong shifts every metadata
    // field one column left and reads as 'CIVL changed their export'.
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1">` +
          `<c r="A1" t="inlineStr"><is><t>ranking_date</t></is></c>` +
          `<c r="B1" s="1"/>` +
          `<c r="C1" t="inlineStr"><is><t>name</t></is></c>` +
          `<c r="D1" s="1"/>` +
          `<c r="E1" t="inlineStr"><is><t>region</t></is></c>` +
          `</row>`,
      ),
    });
    expect(readSheetRows(bytes)).toEqual([
      ["ranking_date", "", "name", "", "region"],
    ]);
  });

  test("honours cell references, so an omitted cell leaves a gap", () => {
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1"><v>1</v></c><c r="D1"><v>4</v></c></row>`,
      ),
    });
    expect(readSheetRows(bytes)).toEqual([["1", "", "", "4"]]);
  });

  test("pads skipped rows so rows[n-1] is spreadsheet row n", () => {
    // The CIVL sheet leaves rows 3 and 4 empty between the metadata block and
    // the pilot table.
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(
        `<row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="A5"><v>5</v></c></row>`,
      ),
    });
    const rows = readSheetRows(bytes);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual(["1"]);
    expect(rows[1]).toEqual([]);
    expect(rows[4]).toEqual(["5"]);
  });

  test("handles columns past Z", () => {
    const bytes = makeZip({
      "xl/worksheets/sheet1.xml": sheet(`<row r="1"><c r="AB1"><v>28</v></c></row>`),
    });
    expect(readSheetRows(bytes)[0]).toHaveLength(28);
    expect(readSheetRows(bytes)[0][27]).toBe("28");
  });
});

describe("readSheetRows — container", () => {
  test("reads stored (uncompressed) entries", () => {
    const bytes = makeZip(
      { "xl/worksheets/sheet1.xml": sheet(`<row r="1"><c r="A1"><v>7</v></c></row>`) },
      false,
    );
    expect(readSheetRows(bytes)).toEqual([["7"]]);
  });

  test("names the missing sheet rather than returning nothing", () => {
    const bytes = makeZip({ "xl/worksheets/sheet1.xml": sheet("") });
    expect(() => readSheetRows(bytes, 2)).toThrow(/no xl\/worksheets\/sheet2\.xml/);
  });

  test("rejects a file that is not a zip", () => {
    expect(() => readSheetRows(new TextEncoder().encode("Rank,CIVL ID\n1,25161"))).toThrow(
      /Not a zip archive/,
    );
  });
});

describe("readSheetRows — the real CIVL export", () => {
  const rows = readSheetRows(
    readFileSync(join(SAMPLES, "hang-gliding-class-1-xc-2026-07.xlsx")),
  );

  test("lands each block on the spreadsheet row it occupies", () => {
    expect(rows).toHaveLength(754);
    expect(rows[0][0]).toBe("ranking_date");
    expect(rows[1][0]).toBe("Jul 1, 2026");
    expect(rows[2]).toEqual([]); // rows 3-4 are blank
    expect(rows[3]).toEqual([]);
    expect(rows[4][0]).toBe("Rank");
    expect(rows[5][2]).toBe("Marco Laurenzi");
    expect(rows[752][0]).toBe("count");
    expect(rows[753][0]).toBe("747");
  });

  test("reads the interleaved metadata header", () => {
    expect(rows[0].slice(0, 9)).toEqual([
      "ranking_date", "", "name", "", "region", "", "selection", "", "created",
    ]);
  });

  test("keeps the 18 pilot-table columns", () => {
    expect(rows[4].slice(0, 6)).toEqual([
      "Rank", "CIVL ID", "Name", "Gender", "Nation", "Points",
    ]);
    expect(rows[4]).toHaveLength(18); // + r1 p1 e1 … r4 p4 e4
  });
});
