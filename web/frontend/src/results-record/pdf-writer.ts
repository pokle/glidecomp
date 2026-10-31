/**
 * The page-layout layer under the results record: A4 landscape pages, wrapped
 * text, tables that break across pages, link annotations and bookmarks, over
 * pdf-lib. It knows nothing about scores — build.ts says what goes where.
 *
 * Why pdf-lib and hand layout rather than printing HTML: a document laid out
 * in code cannot drift when the website's CSS changes, which is the whole
 * reason the scores page stopped being a print target. It is also what lets
 * the file carry its data as attachments (see attachments.ts).
 *
 * Text is drawn in an embedded Noto Sans (Latin, Greek, Cyrillic, Vietnamese),
 * subset to the glyphs a record uses. The PDF base-14 fonts would have needed
 * no embedding but cannot print "Łukasz" or "Beneš", and a record that
 * misspells a pilot's name is a wrong record. A character the font has no
 * glyph for is printed as "?" — the attached CSVs keep every name exactly.
 *
 * Pure: no DOM, no Node APIs, so it runs in the Pages Function (workerd), the
 * Vite dev server and `bun test` alike.
 */
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  rgb,
  type PDFDict,
  type PDFFont,
  type PDFPage,
  type PDFRef,
  type RGB,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

/** A4 landscape, in points. Landscape because a standings table grows a
 * column per task, and a ten-task comp does not fit across portrait A4. */
export const PAGE_WIDTH = 841.89;
export const PAGE_HEIGHT = 595.28;
export const MARGIN_X = 40;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 46;
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;

const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.38, 0.38, 0.43);
const RULE = rgb(0.78, 0.78, 0.81);
const ZEBRA = rgb(0.955, 0.955, 0.965);
const NOTICE = rgb(0.99, 0.95, 0.85);

export interface Fonts {
  regular: Uint8Array;
  bold: Uint8Array;
}

export type Align = "left" | "right";

export interface TableColumn {
  /** One string per header line. */
  header: string | string[];
  /** Fixed width in points; omit for a column that takes the space left. */
  width?: number;
  align?: Align;
}

export interface TableCell {
  text: string;
  bold?: boolean;
  muted?: boolean;
  /** Absolute URL the cell's text links to. */
  link?: string;
}

export type CellInput = string | TableCell;

export interface TextOptions {
  size?: number;
  bold?: boolean;
  muted?: boolean;
  /** Left offset from the margin. */
  indent?: number;
  /** Wrap width; defaults to the rest of the content width. */
  width?: number;
  link?: string;
  /** Extra space after the paragraph. */
  after?: number;
}

interface OutlineItem {
  title: string;
  page: PDFRef;
  top: number;
  children: OutlineItem[];
}

const asCell = (c: CellInput): TableCell => (typeof c === "string" ? { text: c } : c);

interface GlyphTable {
  /** Width at 1 pt. */
  width(text: string): number;
}

/** The slice of a fontkit font this needs (pdf-lib keeps it on the embedder). */
interface FontkitFace {
  unitsPerEm: number;
  glyphForCodePoint(codePoint: number): { id: number; advanceWidth: number };
}

/**
 * Measure and encode text one glyph per code point, from a table built once
 * per face, instead of pdf-lib's per-string fontkit layout.
 *
 * pdf-lib lays a string out twice — once to measure it, once in drawText to
 * encode it — and a big comp's tables do that tens of thousands of times:
 * 120 pilots × 14 tasks took 6.7 s of CPU, which is past what a Worker
 * request should spend. Every script the embedded fonts carry (Latin, Greek,
 * Cyrillic, precomposed Vietnamese) needs no shaping, so a code point's
 * glyph and advance are the whole answer, and measuring and drawing now use
 * the same numbers: a right-aligned column lines up exactly, with no kerning
 * pair to throw it off.
 *
 * The full-font ToUnicode map pdf-lib writes for a non-subset font covers
 * every glyph, so the text still extracts as typed. If a later pdf-lib moved
 * the fontkit face, this falls back to its own measuring and encoding.
 */
function glyphTable(font: PDFFont): GlyphTable {
  const face = (font as unknown as { embedder?: { font?: FontkitFace } }).embedder?.font;
  if (!face || typeof face.glyphForCodePoint !== "function") {
    return { width: (text) => font.widthOfTextAtSize(text, 1) };
  }
  const glyphs = new Map<number, { hex: string; advance: number }>();
  const glyph = (cp: number) => {
    let g = glyphs.get(cp);
    if (!g) {
      const f = face.glyphForCodePoint(cp);
      g = { hex: f.id.toString(16).padStart(4, "0"), advance: f.advanceWidth / face.unitsPerEm };
      glyphs.set(cp, g);
    }
    return g;
  };
  font.encodeText = (text: string) => {
    let hex = "";
    for (const ch of text) hex += glyph(ch.codePointAt(0)!).hex;
    return PDFHexString.of(hex);
  };
  return {
    width(text) {
      let w = 0;
      for (const ch of text) w += glyph(ch.codePointAt(0)!).advance;
      return w;
    },
  };
}

export class PdfWriter {
  readonly doc: PDFDocument;
  private readonly regular: PDFFont;
  private readonly bold: PDFFont;
  private readonly glyphs: Set<number>;
  private readonly outline: OutlineItem[] = [];
  page!: PDFPage;
  /** The top of the next thing to draw, in PDF space (0 = page bottom). */
  y = 0;

  private readonly faces: [GlyphTable, GlyphTable];

  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.faces = [glyphTable(regular), glyphTable(bold)];
    const boldSet = new Set(bold.getCharacterSet());
    // Only what BOTH faces can draw, so a name never prints in one weight
    // and turns into "?" in the other.
    this.glyphs = new Set(regular.getCharacterSet().filter((c) => boldSet.has(c)));
  }

  static async create(fonts: Fonts): Promise<PdfWriter> {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    // Embedded whole, NOT subset: pdf-lib's fontkit subsetter draws the
    // wrong glyphs for Noto Sans (the text still extracts, so only a reader
    // looking at the page notices). The files are pre-subset to the scripts
    // names are written in instead — web/scripts/subset-results-record-fonts.py.
    const [regular, bold] = await Promise.all([
      doc.embedFont(fonts.regular, { subset: false }),
      doc.embedFont(fonts.bold, { subset: false }),
    ]);
    const w = new PdfWriter(doc, regular, bold);
    w.newPage();
    return w;
  }

  // ── Text primitives ────────────────────────────────────────────────────────

  /** Text the embedded fonts can draw: whitespace runs collapsed to one
   * space, and anything without a glyph replaced by "?". */
  clean(text: string): string {
    let out = "";
    for (const ch of text.replace(/\s+/g, " ")) {
      out += this.glyphs.has(ch.codePointAt(0)!) ? ch : "?";
    }
    return out;
  }

  font(bold = false): PDFFont {
    return bold ? this.bold : this.regular;
  }

  width(text: string, size: number, bold = false): number {
    return this.faces[bold ? 1 : 0].width(text) * size;
  }

  /** Greedy word wrap; a word wider than the line breaks by character. */
  wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const clean = this.clean(text).trim();
    if (clean === "") return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of clean.split(" ")) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.width(candidate, size, bold) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (this.width(word, size, bold) <= maxWidth) {
        line = word;
        continue;
      }
      let chunk = "";
      for (const ch of word) {
        if (chunk && this.width(chunk + ch, size, bold) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else chunk += ch;
      }
      line = chunk;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** Draw one already-clean line with its top at `top`. */
  drawLine(
    text: string,
    x: number,
    top: number,
    { size = 9, bold = false, muted = false, color, page = this.page }: {
      size?: number;
      bold?: boolean;
      muted?: boolean;
      color?: RGB;
      page?: PDFPage;
    } = {}
  ): void {
    if (!text) return;
    page.drawText(text, {
      x,
      y: top - size * 0.95,
      size,
      font: this.font(bold),
      color: color ?? (muted ? MUTED : INK),
    });
  }

  /** A clickable rectangle over text already drawn (no underline: on paper
   * a link is just text, and the URL is printed where it matters). */
  link(url: string, x: number, top: number, w: number, h: number, page = this.page): void {
    if (!/^https?:\/\//.test(url)) return;
    const annot = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, top - h, x + w, top],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    page.node.addAnnot(this.doc.context.register(annot));
  }

  // ── Flow ────────────────────────────────────────────────────────────────────

  newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  /** Room left on this page above the bottom margin. */
  get room(): number {
    return this.y - MARGIN_BOTTOM;
  }

  /** Start a new page unless `height` still fits on this one. */
  ensure(height: number): void {
    if (this.room < height) this.newPage();
  }

  space(height: number): void {
    this.y -= height;
  }

  /** A wrapped paragraph. */
  text(text: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 9.5;
    const indent = opts.indent ?? 0;
    const width = opts.width ?? CONTENT_WIDTH - indent;
    const lineHeight = size * 1.35;
    for (const line of this.wrap(text, size, width, opts.bold)) {
      this.ensure(lineHeight);
      this.drawLine(line, MARGIN_X + indent, this.y, opts);
      if (opts.link) {
        this.link(opts.link, MARGIN_X + indent, this.y, this.width(line, size, opts.bold), lineHeight);
      }
      this.y -= lineHeight;
    }
    this.y -= opts.after ?? 0;
  }

  /**
   * A heading, kept with at least `keepWith` points of whatever follows it,
   * and registered as a bookmark: level 1 at the top of the outline, level 2
   * under the latest level 1, level 3 not at all.
   */
  heading(
    text: string,
    level: 1 | 2 | 3,
    { keepWith = 60, link, bookmark = text }: { keepWith?: number; link?: string; bookmark?: string } = {}
  ): void {
    const size = level === 1 ? 17 : level === 2 ? 12.5 : 10.5;
    const before = level === 1 ? 0 : level === 2 ? 12 : 8;
    const lineHeight = size * 1.3;
    if (this.y < PAGE_HEIGHT - MARGIN_TOP) this.y -= before;
    this.ensure(lineHeight + keepWith);
    const top = this.y;
    this.text(text, { size, bold: true, link });
    this.y -= level === 1 ? 4 : 2;
    if (level === 3) return;
    const item: OutlineItem = { title: this.clean(bookmark), page: this.page.ref, top, children: [] };
    if (level === 1 || this.outline.length === 0) this.outline.push(item);
    else this.outline[this.outline.length - 1].children.push(item);
  }

  /** A shaded box around wrapped text, for the one thing a reader must not miss. */
  notice(text: string): void {
    const size = 9.5;
    const pad = 7;
    const lines = this.wrap(text, size, CONTENT_WIDTH - 2 * pad);
    const lineHeight = size * 1.35;
    const h = lines.length * lineHeight + 2 * pad;
    this.ensure(h + 4);
    this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: CONTENT_WIDTH, height: h, color: NOTICE });
    let top = this.y - pad;
    for (const line of lines) {
      this.drawLine(line, MARGIN_X + pad, top, { size });
      top -= lineHeight;
    }
    this.y -= h + 8;
  }

  /** Label/value rows, the label column a fixed width. */
  keyValues(
    rows: Array<[string, CellInput]>,
    { labelWidth = 150, size = 9.5, width = CONTENT_WIDTH }: { labelWidth?: number; size?: number; width?: number } = {}
  ): void {
    const lineHeight = size * 1.35;
    for (const [label, raw] of rows) {
      const value = asCell(raw);
      const lines = this.wrap(value.text, size, width - labelWidth, value.bold);
      this.ensure(lines.length * lineHeight);
      this.drawLine(this.clean(label), MARGIN_X, this.y, { size, muted: true });
      for (const line of lines) {
        this.drawLine(line, MARGIN_X + labelWidth, this.y, { size, bold: value.bold, muted: value.muted });
        if (value.link) {
          this.link(value.link, MARGIN_X + labelWidth, this.y, this.width(line, size, value.bold), lineHeight);
        }
        this.y -= lineHeight;
      }
      this.y -= 1.5;
    }
  }

  /**
   * A table that breaks across pages, repeating its header on each. Fixed
   * columns keep their width; the others share what is left equally. Cells
   * wrap, so a long pilot name makes a taller row rather than running into
   * the next column.
   */
  table(columns: TableColumn[], rows: CellInput[][], { size = 8.5 }: { size?: number } = {}): void {
    const padX = 3.5;
    const padY = 2.6;
    const lineHeight = size * 1.28;
    const fixed = columns.reduce((s, c) => s + (c.width ?? 0), 0);
    const flexCount = columns.filter((c) => c.width == null).length;
    const flexWidth = flexCount ? Math.max(40, (CONTENT_WIDTH - fixed) / flexCount) : 0;
    const widths = columns.map((c) => c.width ?? flexWidth);
    const xs = widths.map((_, i) => MARGIN_X + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const tableWidth = widths.reduce((s, w) => s + w, 0);
    const headerLines = columns.map((c) => (Array.isArray(c.header) ? c.header : [c.header]));
    const headerHeight = Math.max(...headerLines.map((l) => l.length)) * lineHeight + 2 * padY;

    const drawHeader = () => {
      columns.forEach((col, i) => {
        headerLines[i].forEach((raw, li) => {
          const text = this.clean(raw);
          const top = this.y - padY - li * lineHeight;
          const x =
            col.align === "right"
              ? xs[i] + widths[i] - padX - this.width(text, size, true)
              : xs[i] + padX;
          this.drawLine(text, x, top, { size, bold: true });
        });
      });
      this.y -= headerHeight;
      this.page.drawLine({
        start: { x: MARGIN_X, y: this.y },
        end: { x: MARGIN_X + tableWidth, y: this.y },
        thickness: 0.8,
        color: RULE,
      });
    };

    // Keep the header with at least its first row.
    this.ensure(headerHeight + lineHeight + 2 * padY);
    drawHeader();

    rows.forEach((raw, r) => {
      const cells = columns.map((_, i) => asCell(raw[i] ?? ""));
      const wrapped = cells.map((c, i) => this.wrap(c.text, size, widths[i] - 2 * padX, c.bold));
      const h = Math.max(...wrapped.map((l) => l.length)) * lineHeight + 2 * padY;
      if (this.room < h) {
        this.newPage();
        drawHeader();
      }
      if (r % 2 === 1) {
        this.page.drawRectangle({ x: MARGIN_X, y: this.y - h, width: tableWidth, height: h, color: ZEBRA });
      }
      cells.forEach((cell, i) => {
        wrapped[i].forEach((line, li) => {
          const top = this.y - padY - li * lineHeight;
          const w = this.width(line, size, cell.bold);
          const x = columns[i].align === "right" ? xs[i] + widths[i] - padX - w : xs[i] + padX;
          this.drawLine(line, x, top, { size, bold: cell.bold, muted: cell.muted });
          if (cell.link) this.link(cell.link, x, top + 1, w, lineHeight);
        });
      });
      this.y -= h;
    });
    this.y -= 6;
  }

  // ── Finishing ───────────────────────────────────────────────────────────────

  /** Stamp every page's running header and footer, write the bookmarks, and
   * hand back the file. */
  async finish({
    headerLeft,
    headerRight,
    footerLeft,
  }: {
    headerLeft: string;
    headerRight: string;
    footerLeft: string;
  }): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    const size = 7.5;
    pages.forEach((page, i) => {
      const top = PAGE_HEIGHT - 26;
      const left = this.clean(headerLeft);
      const right = this.clean(headerRight);
      this.drawLine(left, MARGIN_X, top, { size, muted: true, page });
      this.drawLine(right, PAGE_WIDTH - MARGIN_X - this.width(right, size), top, { size, muted: true, page });
      page.drawLine({
        start: { x: MARGIN_X, y: top - 12 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: top - 12 },
        thickness: 0.5,
        color: RULE,
      });
      const bottom = 30;
      const pageNo = `Page ${i + 1} of ${pages.length}`;
      this.drawLine(this.clean(footerLeft), MARGIN_X, bottom, { size, muted: true, page });
      this.drawLine(pageNo, PAGE_WIDTH - MARGIN_X - this.width(pageNo, size), bottom, {
        size,
        muted: true,
        page,
      });
    });
    this.writeOutline();
    return this.doc.save();
  }

  /** The bookmarks panel: one entry per section, tasks' classes beneath them. */
  private writeOutline(): void {
    if (this.outline.length === 0) return;
    const ctx = this.doc.context;
    const rootRef = ctx.nextRef();

    const build = (items: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } => {
      const refs = items.map(() => ctx.nextRef());
      let count = items.length;
      items.forEach((item, i) => {
        const dict = ctx.obj({}) as PDFDict;
        dict.set(PDFName.of("Title"), PDFHexString.fromText(item.title));
        dict.set(PDFName.of("Parent"), parent);
        if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]);
        if (i < items.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]);
        dict.set(PDFName.of("Dest"), ctx.obj([item.page, "XYZ", null, item.top + 4, null]));
        if (item.children.length > 0) {
          const sub = build(item.children, refs[i]);
          dict.set(PDFName.of("First"), sub.first);
          dict.set(PDFName.of("Last"), sub.last);
          // Negative: the entry starts closed, so a long comp's bookmarks
          // open as a short list of sections.
          dict.set(PDFName.of("Count"), ctx.obj(-sub.count));
        }
        ctx.assign(refs[i], dict);
      });
      return { first: refs[0], last: refs[refs.length - 1], count };
    };

    const top = build(this.outline, rootRef);
    ctx.assign(
      rootRef,
      ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count })
    );
    this.doc.catalog.set(PDFName.of("Outlines"), rootRef);
    this.doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
  }
}
