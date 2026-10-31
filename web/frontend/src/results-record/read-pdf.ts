/**
 * Read a results record back for the tests: its attachments and bookmarks,
 * through pdf-lib's own object model (it has no text extraction — the text
 * was checked with pdftotext while building this, and the attachments are
 * what software is meant to read anyway). `readZip` does the same for the
 * ZIP of that data.
 */
import { strFromU8, unzipSync } from "fflate";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
} from "pdf-lib";

export async function readRecord(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const attachments = new Map<string, { text: string; description: string }>();
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const tree = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  const list = tree?.lookupMaybe(PDFName.of("Names"), PDFArray);
  for (let i = 0; list && i < list.size(); i += 2) {
    const name = (list.lookup(i) as PDFString | PDFHexString).decodeText();
    const spec = list.lookup(i + 1, PDFDict);
    const stream = spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F")) as PDFRawStream;
    const desc = spec.lookupMaybe(PDFName.of("Desc"), PDFString, PDFHexString);
    attachments.set(name, {
      text: new TextDecoder().decode(decodePDFRawStream(stream).decode()),
      description: desc?.decodeText() ?? "",
    });
  }

  const bookmarks: string[] = [];
  const outlines = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  let item = outlines?.lookupMaybe(PDFName.of("First"), PDFDict);
  while (item) {
    bookmarks.push((item.lookup(PDFName.of("Title")) as PDFHexString).decodeText());
    item = item.lookupMaybe(PDFName.of("Next"), PDFDict);
  }
  const outlineCount = outlines?.lookupMaybe(PDFName.of("Count"), PDFNumber)?.asNumber() ?? 0;

  return { doc, attachments, bookmarks, outlineCount };
}

/** A results ZIP's files, keyed by their path inside the archive. */
export function readZip(bytes: Uint8Array): Map<string, string> {
  const files = unzipSync(bytes);
  return new Map(Object.entries(files).map(([path, data]) => [path, strFromU8(data)]));
}
